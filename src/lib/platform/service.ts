// Platform service: the ONE implementation behind the Preparer API v1 (REST) and the MCP server.
// It only calls the existing engine (state machine) and money guardians — it never moves money itself.
import { z } from "zod";
import { db } from "../db";
import { audit, notify } from "../audit";
import * as engine from "../engine";
import * as money from "../money";
import { now } from "../clock";
import { PREPARER } from "../fixtures";
import { knownSample, sha256 } from "./samples";
import type { KeyContext } from "./keys";

export class PlatformError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type Ctx = KeyContext & { baseUrl: string; actor?: "api" | "mcp" | "arena" };

const MAX_BYTES = 10 * 1024 * 1024;
const UPLOADABLE = ["CONSENTED", "CLARIFY", "DIFFERENCES", "NEEDS_RESCAN", "NEEDS_CONFIRMATION"];

/** Every case created with a key lives in the key's sandbox desk (or a private bucket for desk-less keys). */
export const caseSession = (ctx: KeyContext) => ctx.session ?? `api:${ctx.keyId}`;

// ------------------------------------------------------------------ schemas (shared by REST, MCP and OpenAPI)
export const CreateCaseInput = z.object({
  client_name: z.string().trim().min(3).max(60).describe("Client's full legal name as it will appear on the return"),
  language: z.enum(["es", "en", "pt"]).default("en").describe("Language the client reads (es, en, pt)"),
  fee_usd: z.number().min(10).max(2000).describe("Preparer fee in USD that PayPal will AUTHORIZE when the client approves"),
});
export const SubmitReturnInput = z.object({
  case_id: z.string().min(1).max(64),
  document_base64: z.string().min(16).max(14_000_000).describe("The draft return + unsigned Form 8879, base64 (PDF, PNG or JPEG, ≤10 MB)"),
  media_type: z.enum(["application/pdf", "image/png", "image/jpeg"]).default("application/pdf"),
  filename: z.string().max(120).optional(),
});
export const CaseIdInput = z.object({ case_id: z.string().min(1).max(64) });
export const EfileInput = z.object({
  case_id: z.string().min(1).max(64),
  submission_id: z.string().trim().describe("IRS MeF Submission ID (20 chars: EFIN(6) + year(4) + day-of-year(3) + 7 alphanumerics)"),
});
/** The acknowledgment is a DOCUMENT, read by the quarantined reader and verified by code. There is no `status` field:
 *  nobody gets to declare an IRS acceptance. */
export const AckInput = z
  .object({
    case_id: z.string().min(1).max(64),
    document_base64: z
      .string()
      .min(16)
      .max(14_000_000)
      .describe("The IRS e-file acknowledgment report your tax software produced for the registered Submission ID, base64 (PDF, PNG or JPEG, ≤10 MB)"),
    media_type: z.enum(["application/pdf", "image/png", "image/jpeg"]).default("application/pdf"),
    filename: z.string().max(120).optional(),
  })
  .strict();

// ------------------------------------------------------------------ helpers
async function ownedCase(ctx: Ctx, caseId: string) {
  const c = await db.case.findFirst({ where: { id: caseId, preparerId: ctx.preparerId, demoSession: caseSession(ctx) } });
  if (!c) throw new PlatformError(404, "case_not_found", "No case with that id for this API key.");
  return c;
}

function decodeFile(b64: string, mediaType: string) {
  const buf = Buffer.from(b64.replace(/^data:[^,]+,/, ""), "base64");
  if (!buf.length) throw new PlatformError(400, "empty_document", "The document is empty or not valid base64.");
  if (buf.length > MAX_BYTES) throw new PlatformError(413, "document_too_large", "Documents must be 10 MB or smaller.");
  const magic: Record<string, (b: Buffer) => boolean> = {
    "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
    "image/png": (b) => b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG",
    "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  };
  if (!magic[mediaType]?.(buf)) throw new PlatformError(415, "unsupported_document", `The file is not a valid ${mediaType}.`);
  return buf;
}

const STATE_HELP: Record<string, { next: string[]; waiting_on: string }> = {
  CASE_CREATED: { next: [], waiting_on: "client: answer the interview at the client link" },
  CONSENTED: { next: ["submit_return"], waiting_on: "preparer: submit the draft return + unsigned 8879" },
  PROCESSING: { next: [], waiting_on: "SignClear: reading the document" },
  CLARIFY: { next: ["submit_return"], waiting_on: "client: confirm small differences, then approve in PayPal" },
  DIFFERENCES: { next: ["submit_return"], waiting_on: "preparer: the client found IMPORTANT differences; fix the return and re-submit" },
  NEEDS_RESCAN: { next: ["submit_return"], waiting_on: "preparer: upload a clearer document" },
  NEEDS_CONFIRMATION: { next: ["submit_return"], waiting_on: "preparer: totals don't add up; re-submit a corrected return" },
  MATCH: { next: [], waiting_on: "client: approve the return; PayPal then AUTHORIZES (holds) the fee" },
  AUTHORIZED: { next: ["record_efile_submission"], waiting_on: "preparer: e-file and register the IRS Submission ID" },
  TRANSMITTED: { next: ["upload_irs_acknowledgment", "request_fee_capture"], waiting_on: "preparer: upload the IRS acknowledgment (Accepted) before the deadline" },
  CAPTURE_PENDING: { next: [], waiting_on: "PayPal: completing the capture" },
  CAPTURED: { next: [], waiting_on: "nothing: fee collected" },
  VOIDED: { next: [], waiting_on: "nothing: the hold was released (no IRS acceptance before the deadline, or client cancelled)" },
};

// ------------------------------------------------------------------ operations
/** POST /v1/cases with `Idempotency-Key`: a retry with the same key (same preparer + desk) returns the same case. */
export async function createClientCase(ctx: Ctx, raw: unknown, opts: { idempotencyKey?: string | null } = {}) {
  const i = CreateCaseInput.parse(raw);
  const idem = opts.idempotencyKey?.trim();
  let slot: { id: string } | null = null;
  if (idem) {
    if (!/^[!-~]{1,255}$/.test(idem)) throw new PlatformError(400, "invalid_idempotency_key", "Idempotency-Key must be 1–255 visible ASCII characters.");
    const scope = caseSession(ctx);
    const bodyHash = sha256(Buffer.from(JSON.stringify(i)));
    const where = { preparerId_scope_key: { preparerId: ctx.preparerId, scope, key: idem } };
    try {
      slot = await db.idempotencyKey.create({ data: { preparerId: ctx.preparerId, scope, key: idem, bodyHash }, select: { id: true } });
    } catch {
      const prev = await db.idempotencyKey.findUnique({ where });
      if (!prev) throw new PlatformError(409, "idempotency_conflict", "Retry the request.");
      if (prev.bodyHash !== bodyHash) throw new PlatformError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.");
      if (!prev.caseId) throw new PlatformError(409, "idempotency_in_progress", "The original request with this Idempotency-Key is still being processed; retry shortly.");
      const c = await db.case.findUniqueOrThrow({ where: { id: prev.caseId } });
      return { ...caseCreatedBody(ctx, c), idempotent_replay: true };
    }
  }
  try {
    // Arena cases (in-process runner only) use the PayPal simulator; nothing reachable over HTTP can set this.
    const c = await engine.createCase(caseSession(ctx), i.client_name, i.language, Math.round(i.fee_usd * 100), { paypalSim: ctx.actor === "arena" });
    await audit(c.id, "user", "platform_case_created", { detail: { via: ctx.actor ?? "api", key: ctx.prefix, idempotencyKey: idem ? true : undefined } });
    if (slot) await db.idempotencyKey.update({ where: { id: slot.id }, data: { caseId: c.id } });
    return caseCreatedBody(ctx, c);
  } catch (e) {
    if (slot) await db.idempotencyKey.delete({ where: { id: slot.id } }).catch(() => {});
    throw e;
  }
}

function caseCreatedBody(ctx: Ctx, c: { id: string; state: string; clientName: string; fee: number; clientToken: string; preparerToken: string }) {
  return {
    case_id: c.id,
    state: c.state,
    client_name: c.clientName,
    fee_usd: c.fee / 100,
    client_link: `${ctx.baseUrl}/c/${c.clientToken}`,
    preparer_link: `${ctx.baseUrl}/p/${c.preparerToken}`,
    next: "Send client_link to the client. They answer a short interview; then submit the return with submit_return.",
  };
}

export async function submitReturn(ctx: Ctx, raw: unknown) {
  const i = SubmitReturnInput.parse(raw);
  const c = await ownedCase(ctx, i.case_id);
  if (c.state === "CASE_CREATED")
    throw new PlatformError(409, "client_interview_pending", "The client has not answered the interview yet. Share the client link and try again after they finish.", { state: c.state });
  if (!UPLOADABLE.includes(c.state))
    throw new PlatformError(409, "invalid_state", `Cannot submit a return in state ${c.state}.`, { state: c.state });
  const buf = decodeFile(i.document_base64, i.media_type);
  const hash = sha256(buf);
  await db.document.create({ data: { caseId: c.id, kind: "DRAFT_1040", filename: (i.filename ?? "return").slice(0, 120), sha256: hash, path: "(not stored)" } });
  const sample = await knownSample(hash);
  let result: { verdict: string; findings: { rule: string; severity: string; message: { en: string } }[] };
  if (sample) {
    // Byte-identical to a known sample: replay its cached extraction (no model call).
    await engine.setState(c.id, "PROCESSING");
    await engine.storeValues(c.id, "DRAFT_1040", sample.values);
    await audit(c.id, "ai", "read_document", { detail: { mode: "cached", sample: sample.id, sha256: hash, via: ctx.actor ?? "api" } });
    await notify(c.id, "client", {
      es: `${PREPARER.name} subió su declaración. Ya puede revisarla.`,
      en: `${PREPARER.name} uploaded your return. You can review it now.`,
      pt: `${PREPARER.name} enviou sua declaração. Já pode revisá-la.`,
    });
    result = await engine.review(c.id);
  } else {
    try {
      result = await engine.uploadDraft(c.id, { base64: buf.toString("base64"), mediaType: i.media_type });
    } catch (e) {
      throw new PlatformError(422, "unreadable_document", String((e as Error).message ?? e));
    }
  }
  return {
    case_id: c.id,
    state: result.verdict,
    review: summarizeFindings(result.findings),
    next:
      result.verdict === "DIFFERENCES"
        ? "The client's review found IMPORTANT differences. The client will NOT be asked to approve this version; the fee cannot be authorized. Fix the return and re-submit."
        : "The client now reviews the return with Clara. When they approve, PayPal AUTHORIZES (holds) your fee.",
  };
}

function summarizeFindings(f: { rule: string; severity: string; message: { en: string } | string; resolved?: boolean }[]) {
  return f.map((x) => ({
    rule: x.rule,
    severity: x.severity,
    message: typeof x.message === "string" ? (JSON.parse(x.message) as { en: string }).en : x.message.en,
    ...(x.resolved !== undefined ? { resolved: x.resolved } : {}),
  }));
}

export async function getCaseStatus(ctx: Ctx, raw: unknown) {
  const { case_id } = CaseIdInput.parse(raw);
  await ownedCase(ctx, case_id);
  const c = await db.case.findUniqueOrThrow({ where: { id: case_id }, include: { payment: true, preparer: true, findings: true } });
  const help = STATE_HELP[c.state] ?? { next: [], waiting_on: "see state" };
  const capture = c.payment ? money.captureConditions(c) : ["no authorization: the client has not approved the return in PayPal"];
  return {
    case_id: c.id,
    client_name: c.clientName,
    state: c.state,
    waiting_on: help.waiting_on,
    next_allowed_actions: help.next,
    fee_usd: c.fee / 100,
    findings: summarizeFindings(c.findings),
    payment: {
      status: c.payment?.status ?? "NONE",
      amount_usd: c.fee / 100,
      authorized: !!c.payment?.authorizationId,
      captured: !!c.payment?.captureId,
      authorization_expires_at: c.payment?.expirationTime ?? null,
    },
    efile: { submission_id: c.submissionId, transmitted_at: c.transmittedAt, irs_ack_received_at: c.ackReceivedAt, irs_ack_deadline: c.ackDeadline },
    capture_guardian: { would_allow: capture.length === 0, refused_conditions: capture },
    client_link: `${ctx.baseUrl}/c/${c.clientToken}`,
    now: now(c),
  };
}

export async function recordEfileSubmission(ctx: Ctx, raw: unknown) {
  const i = EfileInput.parse(raw);
  const c = await ownedCase(ctx, i.case_id);
  try {
    await engine.registerTransmission(c.id, i.submission_id);
  } catch (e) {
    throw new PlatformError(409, "transmission_refused", String((e as Error).message), { state: c.state });
  }
  return { case_id: c.id, state: "TRANSMITTED", submission_id: i.submission_id, next: "Upload the IRS acknowledgment (Accepted) before the deadline; that is what releases your fee." };
}

export async function uploadIrsAcknowledgment(ctx: Ctx, raw: unknown) {
  const i = AckInput.parse(raw);
  const c = await ownedCase(ctx, i.case_id);
  const buf = decodeFile(i.document_base64, i.media_type);
  const { verifyAcknowledgment, AckError } = await import("../ack");
  try {
    const r = await verifyAcknowledgment(c.id, { bytes: buf, mediaType: i.media_type, filename: i.filename }, { via: ctx.actor ?? "api" });
    return {
      case_id: c.id,
      ok: r.ok,
      verdict: r.verdict,
      state: r.state,
      captured: r.captured,
      message: r.message,
      acknowledgment_read: r.read,
      checks: r.checks,
      ...(r.blocked ? { blocked: r.blocked } : {}),
      ...(r.verdict === "REJECTED_BY_IRS" ? { next: "Correct the return, retransmit, and register the new Submission ID with record_efile_submission before the deadline." } : {}),
    };
  } catch (e) {
    if (e instanceof AckError) throw new PlatformError(e.status, e.code, e.message, { state: c.state });
    throw e;
  }
}

export async function requestFeeCapture(ctx: Ctx, raw: unknown) {
  const { case_id } = CaseIdInput.parse(raw);
  const c = await ownedCase(ctx, case_id);
  await audit(c.id, "user", "platform_request_capture", { detail: { via: ctx.actor ?? "api", key: ctx.prefix } });
  // The money guardian decides. Its refusal reasons are returned verbatim.
  const g = await money.capture(c.id, "system", `Capture requested by the preparer via ${ctx.actor ?? "api"} (key ${ctx.prefix}…)`);
  const after = await db.case.findUniqueOrThrow({ where: { id: c.id } });
  return {
    case_id: c.id,
    ok: g.ok,
    captured: after.state === "CAPTURED",
    state: after.state,
    guardian: "money.capture (R13)",
    ...(g.blocked ? { refused_conditions: g.blocked } : {}),
    ...(g.already ? { already: true } : {}),
  };
}

export async function listCases(ctx: Ctx) {
  const rows = await db.case.findMany({
    where: { preparerId: ctx.preparerId, demoSession: caseSession(ctx) },
    include: { payment: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return {
    cases: rows.map((c) => ({
      case_id: c.id,
      client_name: c.clientName,
      state: c.state,
      fee_usd: c.fee / 100,
      payment_status: c.payment?.status ?? "NONE",
      created_at: c.createdAt,
    })),
  };
}

/** Maps any error to a JSON-safe shape (zod issues, platform errors, internal errors). */
export function toErrorBody(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof PlatformError) return { status: e.status, body: { error: e.code, message: e.message, ...e.extra } };
  if (e instanceof z.ZodError)
    return { status: 400, body: { error: "invalid_request", message: "Invalid input", issues: e.issues.map((x) => ({ path: x.path.join("."), message: x.message })) } };
  console.error("platform error", e);
  return { status: 500, body: { error: "internal_error", message: "Something went wrong." } };
}
