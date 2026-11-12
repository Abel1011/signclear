// IRS e-file acknowledgment: the preparer uploads the DOCUMENT; the quarantined reader transcribes it;
// deterministic code decides whether it proves an IRS acceptance of THIS case's submission.
// Only then is ackReceivedAt set and the money guardian (R13) asked to capture. Nobody can just declare "Accepted".
import crypto from "node:crypto";
import { db } from "./db";
import { audit, notify } from "./audit";
import { now } from "./clock";
import { readAcknowledgment, cleanAck, type AckRead } from "./reader";
import { renderAckPdf } from "./ack-pdf";
import * as money from "./money";

export type AckFile = { bytes: Buffer; mediaType: string; filename?: string };
export type AckCheck = { id: string; ok: boolean; detail: string };
export type AckVerdict = "ACCEPTED" | "REJECTED_BY_IRS" | "REFUSED";
export type AckResult = {
  ok: boolean;
  verdict: AckVerdict;
  state: string;
  captured: boolean;
  read: AckRead;
  checks: AckCheck[];
  message: string;
  blocked?: string[];
};

export const ACK_MAX_BYTES = 10 * 1024 * 1024;
export const ACK_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Same person: identical after normalization, or same first and last name (middle names may be omitted). */
export function sameTaxpayer(a: string, b: string) {
  const x = norm(a).split(" ");
  const y = norm(b).split(" ");
  if (!x[0] || !y[0]) return false;
  return x.join(" ") === y.join(" ") || (x[0] === y[0] && x[x.length - 1] === y[y.length - 1]);
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Pure: every condition an acknowledgment must meet to release the fee. */
export function checkAck(
  r: AckRead,
  k: { submissionId: string | null; efin: string; clientName: string; last4s: string[]; transmittedAt: Date | null; now: Date },
): { checks: AckCheck[]; identityOk: boolean; accepted: boolean } {
  const sid = k.submissionId;
  const checks: AckCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  add("document", r.is_efile_acknowledgment, r.is_efile_acknowledgment ? "IRS e-file acknowledgment report" : "the document is not an IRS e-file acknowledgment");
  add("submission_id", !!sid && r.submission_id === sid, !r.submission_id ? "no Submission ID on the acknowledgment" : r.submission_id === sid ? `Submission ID ${sid} matches the registered one` : `acknowledgment is for ${r.submission_id}, but this case registered ${sid ?? "none"}`);
  const efinOk = !!r.submission_id && r.submission_id.startsWith(k.efin) && (!r.efin || r.efin === k.efin);
  add("efin", efinOk, efinOk ? `transmitted under the preparer's EFIN ${k.efin}` : `EFIN on the acknowledgment (${r.efin ?? r.submission_id?.slice(0, 6) ?? "none"}) is not the preparer's EFIN ${k.efin}`);
  const expectYear = sid ? Number(sid.slice(6, 10)) - 1 : null;
  add("tax_year", r.tax_year !== null && r.tax_year === expectYear, r.tax_year === null ? "no tax year on the acknowledgment" : r.tax_year === expectYear ? `tax year ${r.tax_year}` : `tax year ${r.tax_year}, expected ${expectYear}`);
  const nameOk = r.taxpayer_name ? sameTaxpayer(r.taxpayer_name, k.clientName) : null;
  const last4Ok = r.ssn_last4 ? k.last4s.includes(r.ssn_last4) : null;
  const who = nameOk !== false && last4Ok !== false && (nameOk || last4Ok) === true;
  add(
    "taxpayer",
    who,
    nameOk === null && last4Ok === null
      ? "the acknowledgment does not identify the taxpayer"
      : who
        ? `taxpayer ${r.taxpayer_name ?? ""}${r.ssn_last4 ? ` ***-**-${r.ssn_last4}` : ""} is the client`.replace("  ", " ")
        : `taxpayer on the acknowledgment (${r.taxpayer_name ?? "?"}${r.ssn_last4 ? `, SSN ****${r.ssn_last4}` : ""}) is not the client ${k.clientName}`,
  );
  const tx = k.transmittedAt ? day(k.transmittedAt) : null;
  const dateOk = !!r.ack_date && !!tx && r.ack_date >= tx && r.ack_date <= day(k.now);
  add("date", dateOk, !r.ack_date ? "no acknowledgment date" : dateOk ? `acknowledged ${r.ack_date} (transmitted ${tx})` : `acknowledgment date ${r.ack_date} is not between the transmission (${tx ?? "none"}) and today (${day(k.now)})`);
  add("status", r.status === "Accepted", r.status === "Accepted" ? "status Accepted" : `status is ${r.status}, not Accepted`);
  const identityOk = checks.filter((c) => ["document", "submission_id", "efin", "taxpayer"].includes(c.id)).every((c) => c.ok);
  return { checks, identityOk, accepted: checks.every((c) => c.ok) };
}

async function readCached(file: AckFile, hash: string, signal?: AbortSignal) {
  const hit = await db.readerCache.findUnique({ where: { sha256: hash } });
  if (hit && hit.kind === "IRS_ACK") return { read: cleanAck(JSON.parse(hit.data) as AckRead), mode: "cached", model: hit.model };
  const r = await readAcknowledgment({ base64: file.bytes.toString("base64"), mediaType: file.mediaType }, signal);
  await db.readerCache.upsert({ where: { sha256: hash }, create: { sha256: hash, kind: "IRS_ACK", data: JSON.stringify(r.read), model: r.model }, update: {} });
  return { read: r.read, mode: "live", model: r.model, latencyMs: r.latencyMs, usage: r.usage };
}

/** Reads + verifies an acknowledgment for a TRANSMITTED case; on a proven acceptance asks the money guardian to capture.
 *  `known` (server-rendered sample used only by internal seeding) skips the model; everything else is identical. */
export async function verifyAcknowledgment(caseId: string, file: AckFile, opts: { via: string; known?: AckRead; signal?: AbortSignal }): Promise<AckResult> {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId }, include: { preparer: true, intake: true } });
  if (c.state !== "TRANSMITTED" || c.ackReceivedAt) throw new AckError(409, "invalid_state", `An IRS acknowledgment is not accepted in state ${c.state}${c.ackReceivedAt ? " (already on file)" : ""}.`);
  if (!file.bytes.length || file.bytes.length > ACK_MAX_BYTES) throw new AckError(413, "document_too_large", "The acknowledgment must be a PDF, PNG or JPEG of 10 MB or less.");
  const hash = crypto.createHash("sha256").update(file.bytes).digest("hex");
  await db.document.create({ data: { caseId, kind: "ACK", filename: (file.filename ?? "irs-ack").slice(0, 120), sha256: hash, path: "(not stored)" } });
  let got: Awaited<ReturnType<typeof readCached>> | { read: AckRead; mode: string; model: string };
  try {
    got = opts.known ? { read: cleanAck(opts.known), mode: "rendered-sample", model: "none" } : await readCached(file, hash, opts.signal ?? AbortSignal.timeout(60_000));
  } catch (e) {
    await audit(caseId, "ai", "read_ack_failed", { detail: { error: String(e).slice(0, 200), sha256: hash, via: opts.via } });
    throw new AckError(422, "unreadable_document", "We couldn't read that acknowledgment. Upload the e-file acknowledgment report (PDF or a clear photo).");
  }
  const r = got.read;
  const draft = await db.extractedValue.findFirst({ where: { caseId, docKind: "DRAFT_1040", label: "ssn_last4" } });
  const intakeLast4 = c.intake ? (JSON.parse(c.intake.data) as { last4?: string }).last4 : undefined;
  const t = now(c);
  const res = checkAck(r, {
    submissionId: c.submissionId,
    efin: c.preparer.efin,
    clientName: c.clientName,
    last4s: [intakeLast4, draft?.value].filter((x): x is string => !!x),
    transmittedAt: c.transmittedAt,
    now: t,
  });
  // What Clara read is stored as extracted values (docKind IRS_ACK), replaced on each upload.
  await db.extractedValue.deleteMany({ where: { caseId, docKind: "IRS_ACK" } });
  const vals: [string, string | number | boolean | null][] = [
    ["ack_submission_id", r.submission_id],
    ["ack_status", r.status],
    ["ack_efin", r.efin],
    ["ack_taxpayer_name", r.taxpayer_name],
    ["ack_ssn_last4", r.ssn_last4],
    ["ack_tax_year", r.tax_year],
    ["ack_date", r.ack_date],
    ["ack_transmitted_date", r.transmitted_date],
    ["ack_verified", res.accepted],
    ["ack_identity_ok", res.identityOk],
  ];
  await db.extractedValue.createMany({ data: vals.map(([label, v]) => ({ caseId, docKind: "IRS_ACK", form: "IRS_ACK", line: "", label, value: v === null ? "" : String(v), page: 1 })) });
  const failed = res.checks.filter((x) => !x.ok);
  const verdict: AckVerdict = res.accepted ? "ACCEPTED" : res.identityOk && r.status === "Rejected" ? "REJECTED_BY_IRS" : "REFUSED";
  await audit(caseId, opts.known ? "system" : "ai", res.accepted ? "irs_ack_verified" : "irs_ack_refused", {
    rationale: res.accepted ? "IRS acknowledgment read and verified by code" : failed.map((x) => x.detail).join("; "),
    detail: { verdict, sha256: hash, mode: got.mode, model: got.model, via: opts.via, read: r, checks: res.checks },
  });
  const base = { read: r, checks: res.checks };
  if (verdict === "REJECTED_BY_IRS") {
    await notify(caseId, "preparer", {
      es: `El IRS rechazó la declaración de ${c.clientName}. Corrija y retransmita antes de la fecha límite.`,
      en: `The IRS rejected ${c.clientName}'s return. Correct it and retransmit before the deadline.`,
      pt: `O IRS rejeitou a declaração de ${c.clientName}. Corrija e retransmita antes do prazo.`,
    });
    return {
      ok: false,
      verdict,
      state: c.state,
      captured: false,
      ...base,
      message: "Rejected — correct and retransmit. The fee stays held; register the new Submission ID before the deadline.",
      blocked: ["R13: the IRS acknowledgment says Rejected — correct the return and retransmit (register the new Submission ID before the deadline)"],
    };
  }
  if (!res.accepted)
    return { ok: false, verdict, state: c.state, captured: false, ...base, message: "This acknowledgment does not prove an IRS acceptance of this case's submission. The fee was not captured.", blocked: failed.map((x) => `R13: ${x.detail}`) };
  await db.case.updateMany({ where: { id: caseId, state: "TRANSMITTED", ackReceivedAt: null }, data: { ackReceivedAt: t, version: { increment: 1 } } });
  await audit(caseId, "user", "irs_confirmation_uploaded", { detail: { status: "Accepted", verified: true, submissionId: c.submissionId, sha256: hash, via: opts.via } });
  const g = await money.capture(caseId, "system", `IRS acknowledgment read and verified: Accepted, Submission ID ${c.submissionId} under EFIN ${c.preparer.efin}`);
  const after = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  return {
    ok: g.ok,
    verdict,
    state: after.state,
    captured: after.state === "CAPTURED",
    ...base,
    message: g.ok ? "IRS acceptance verified; the money guardian released the fee." : "IRS acceptance verified, but the money guardian refused the capture.",
    ...(g.blocked ? { blocked: g.blocked } : {}),
  };
}

export class AckError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Renders the (fictitious) acknowledgment report for a case's registered Submission ID. */
export async function sampleAckFor(caseId: string, status: "Accepted" | "Rejected" = "Accepted") {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId }, include: { preparer: true, intake: true } });
  if (!c.submissionId || !c.transmittedAt) throw new AckError(409, "not_transmitted", "Register the e-file Submission ID first.");
  const last4 = (c.intake ? (JSON.parse(c.intake.data) as { last4?: string }).last4 : undefined) ?? "0000";
  const input = {
    submissionId: c.submissionId,
    status,
    efin: c.preparer.efin,
    ero: `${c.preparer.business} (${c.preparer.name})`,
    taxpayerName: c.clientName,
    ssnLast4: last4,
    taxYear: Number(c.submissionId.slice(6, 10)) - 1,
    transmittedAt: c.transmittedAt,
    ackDate: now(c) < c.transmittedAt ? c.transmittedAt : now(c),
  } as const;
  const bytes = Buffer.from(await renderAckPdf(input));
  const truth: AckRead = {
    is_efile_acknowledgment: true,
    submission_id: input.submissionId,
    status,
    efin: input.efin,
    taxpayer_name: input.taxpayerName,
    ssn_last4: input.ssnLast4,
    tax_year: input.taxYear,
    ack_date: input.ackDate.toISOString().slice(0, 10),
    transmitted_date: input.transmittedAt.toISOString().slice(0, 10),
  };
  return { bytes, truth, filename: `irs-ack-${c.submissionId}.pdf` };
}

/** The last verified IRS rejection of the CURRENT submission (allows re-registering a corrected one). */
export async function currentSubmissionRejected(caseId: string, submissionId: string | null) {
  if (!submissionId) return false;
  const rows = await db.extractedValue.findMany({ where: { caseId, docKind: "IRS_ACK", label: { in: ["ack_status", "ack_submission_id", "ack_identity_ok"] } } });
  const v = Object.fromEntries(rows.map((x) => [x.label, x.value]));
  return v.ack_status === "Rejected" && v.ack_submission_id === submissionId && v.ack_identity_ok === "true";
}

/** What Clara read from the last acknowledgment (for the desk). */
export async function lastAckView(caseId: string) {
  const ev = await db.auditEvent.findFirst({ where: { caseId, action: { in: ["irs_ack_verified", "irs_ack_refused"] } }, orderBy: { createdAt: "desc" } });
  if (!ev) return null;
  const d = JSON.parse(ev.detail) as { verdict: AckVerdict; read: AckRead; checks: AckCheck[]; mode: string };
  return { at: ev.createdAt, verdict: d.verdict, read: d.read, checks: d.checks, mode: d.mode };
}
