import { NextResponse, after } from "next/server";
import { resolveToken } from "@/lib/view";
import { db } from "@/lib/db";
import * as engine from "@/lib/engine";
import * as money from "@/lib/money";
import { runAgent } from "@/lib/agent";
import { MARIA_INTAKE } from "@/lib/fixtures";
import { audit, notify } from "@/lib/audit";
import { H } from "@/lib/clock";
import type { Intake } from "@/lib/rules";

export const dynamic = "force-dynamic";

const CLIENT = new Set(["send_questions", "submit_intake", "accept_clarifications", "chat", "cancel", "report_refund", "upload_transcript", "confirm_refund", "set_lang", "mark_read"]);
const PREPARER = new Set(["reply_client", "upload_draft", "register_transmission", "upload_ack", "request_capture", "respond", "mark_read"]);
const DEMO = new Set(["advance_clock"]);
const LANGS = new Set(["es", "en", "pt"]);
// Each of these runs the Claude agent: bound the cost per case.
const AI_ACTIONS = new Set(["chat", "respond", "set_lang", "request_capture", "send_questions"]);
const aiHits = new Map<string, number[]>();
function limitedAi(caseId: string, max = 15, windowMs = 10 * 60_000) {
  const now = Date.now();
  const arr = (aiHits.get(caseId) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  aiHits.set(caseId, arr);
  return arr.length > max;
}
// Acknowledgment reads call the model: bound them per case (same budget as API v1 heavy calls).
const ackHits = new Map<string, number[]>();
function limitedAck(caseId: string) {
  return limitedIn(ackHits, caseId, 10, 10 * 60_000);
}
function limitedIn(m: Map<string, number[]>, k: string, max: number, windowMs: number) {
  const t = Date.now();
  const arr = (m.get(k) ?? []).filter((x) => t - x < windowMs);
  arr.push(t);
  m.set(k, arr);
  return arr.length > max;
}
const MAX_UPLOAD_B64 = 14_000_000; // ≈10 MB file
const UPLOAD_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

/** Validates and bounds the client's interview answers (they reach the agent as data, so keep them short and typed). */
function cleanIntake(x: unknown): Intake | null {
  const i = (x ?? {}) as Partial<Intake>;
  const str = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  const money = (n: unknown) => (n == null || n === "" ? null : Number.isFinite(Number(n)) && Number(n) >= 0 && Number(n) < 1e9 ? Math.round(Number(n)) : null);
  const name = str(i.name, 60);
  const last4 = str(i.last4, 4);
  const acct = str(i.refundAcctLast4, 4);
  if (name.length < 3 || !/^\d{4}$/.test(last4) || !/^\d{4}$/.test(acct)) return null;
  const deps = (Array.isArray(i.dependents) ? i.dependents : []).slice(0, 8).map((d) => ({
    relation: str(d?.relation, 24),
    birthYear: Math.min(2026, Math.max(1900, Math.round(Number(d?.birthYear) || 0))),
    months: Math.min(12, Math.max(0, Math.round(Number(d?.months) || 0))),
    country: "US",
  }));
  if (deps.some((d) => !d.relation)) return null;
  const SE = ["none", "<10k", "10-20k", "20-40k", ">40k"] as const;
  return {
    name,
    last4,
    idType: i.idType === "ITIN" ? "ITIN" : "SSN",
    dependents: deps,
    w2Wages: money(i.w2Wages),
    w2Withholding: money(i.w2Withholding),
    selfEmployed: SE.includes(i.selfEmployed as (typeof SE)[number]) ? (i.selfEmployed as Intake["selfEmployed"]) : "none",
    expenses: Array.isArray(i.expenses) && i.expenses.includes("education") ? ["education"] : [],
    refundAcctLast4: acct,
    refundAcctType: i.refundAcctType === "savings" ? "savings" : "checking",
    payMethod: "separate",
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const who = await resolveToken(token);
    if (!who) return NextResponse.json({ error: "invalid link" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { type?: string; [k: string]: unknown };
    const type = String(body.type ?? "");
    const c = await db.case.findUniqueOrThrow({ where: { id: who.caseId } });
    // The simulated clock is a sandbox control on the preparer side; a client link alone can't fast-forward time.
    const allowed = (who.role === "client" ? CLIENT : PREPARER).has(type) || (c.isDemo && who.role === "preparer" && DEMO.has(type));
    if (allowed && AI_ACTIONS.has(type) && limitedAi(c.id)) return NextResponse.json({ error: "Too many requests; please wait a minute." }, { status: 429 });
    if (!allowed) return NextResponse.json({ error: `action ${type} not allowed for ${who.role}` }, { status: 403 });
    const id = c.id;
    switch (type) {
      case "set_lang": {
        const lang = String(body.lang);
        if (!LANGS.has(lang)) return NextResponse.json({ error: "unsupported language" }, { status: 400 });
        await db.case.update({ where: { id }, data: { clientLang: lang } });
        // Re-explain the review in the new language (Clara's earlier messages stay in history).
        if (lang !== c.clientLang && ["CLARIFY", "DIFFERENCES", "MATCH"].includes(c.state)) after(() => runAgent(id, "review_ready"));
        break;
      }
      case "mark_read":
        await db.notification.updateMany({ where: { caseId: id, audience: who.role }, data: { read: true } });
        break;
      case "submit_intake": {
        if (c.state !== "CASE_CREATED" && c.state !== "CLARIFY" && c.state !== "DIFFERENCES")
          return NextResponse.json({ error: `answers are locked in state ${c.state}` }, { status: 409 });
        if (body.sample && !c.isDemo) return NextResponse.json({ error: "sample answers are demo-only" }, { status: 400 });
        const intake = body.sample ? { ...MARIA_INTAKE, name: c.clientName } : cleanIntake(body.intake);
        if (!intake) return NextResponse.json({ error: "please complete the interview" }, { status: 400 });
        await engine.submitIntake(id, intake, (body.consents as { review: boolean; other: boolean }) ?? { review: false, other: false });
        break;
      }
      case "send_questions": {
        const m = await db.chatMessage.findFirst({ where: { id: String(body.id ?? ""), caseId: id } });
        if (!m || !m.text.startsWith("__QUESTIONS__")) return NextResponse.json({ error: "no questions to send" }, { status: 400 });
        await db.chatMessage.update({ where: { id: m.id }, data: { text: "__QUESTIONS_SENT__" + m.text.slice(13) } });
        await audit(id, "user", "questions_sent_to_preparer");
        await notify(id, "preparer", {
          es: `${c.clientName} le envió preguntas sobre su declaración.`,
          en: `${c.clientName} sent you questions about the return.`,
          pt: `${c.clientName} enviou perguntas sobre a declaração.`,
        });
        break;
      }
      case "reply_client": {
        const text = String(body.text ?? "").trim().slice(0, 800);
        if (!text) return NextResponse.json({ error: "empty reply" }, { status: 400 });
        await db.chatMessage.create({ data: { caseId: id, role: "preparer", text } });
        await audit(id, "user", "preparer_replied_client");
        await notify(id, "client", { es: `${c.clientName.split(" ")[0]}, su preparador le respondió.`, en: `${c.clientName.split(" ")[0]}, your preparer replied.`, pt: `${c.clientName.split(" ")[0]}, seu preparador respondeu.` });
        break;
      }
      case "accept_clarifications":
        await engine.acceptClarifications(id);
        break;
      case "chat": {
        const text = String(body.text ?? "").trim().slice(0, 600);
        if (!text) return NextResponse.json({ error: "empty message" }, { status: 400 });
        await db.chatMessage.create({ data: { caseId: id, role: "client", text } });
        after(() => runAgent(id, "client_message", { text }));
        break;
      }
      case "cancel":
        return NextResponse.json(await money.voidAuth(id, "client_cancel"));
      case "report_refund": {
        const cents = Math.round(Number(body.amount) * 100);
        const r = await engine.reportRefund(id, cents);
        if (!r.matched) after(() => runAgent(id, "refund_reported", { received: cents, approved: r.approved }));
        return NextResponse.json(r);
      }
      case "upload_transcript": {
        const r = await engine.uploadTranscript(id);
        after(() => runAgent(id, "evidence_uploaded", { proposed: r.ok }));
        return NextResponse.json(r);
      }
      case "confirm_refund":
        return NextResponse.json(await engine.clientConfirmRefund(id));
      case "upload_draft": {
        if (!["CONSENTED", "CLARIFY", "DIFFERENCES", "NEEDS_RESCAN", "NEEDS_CONFIRMATION"].includes(c.state))
          return NextResponse.json({ error: `cannot upload in state ${c.state}` }, { status: 409 });
        const live = body.file as { base64: string; mediaType: string } | undefined;
        if (live && (typeof live.base64 !== "string" || live.base64.length > MAX_UPLOAD_B64 || !UPLOAD_TYPES.has(String(live.mediaType))))
          return NextResponse.json({ error: "Upload a PDF, PNG, JPEG or WebP file up to 10 MB." }, { status: 400 });
        if (!live && c.scenario !== "maria") return NextResponse.json({ error: "a PDF or image of the return is required" }, { status: 400 });
        await engine.uploadDraft(id, live);
        after(() => runAgent(id, "review_ready"));
        break;
      }
      case "register_transmission":
        await engine.registerTransmission(id, body.submissionId ? String(body.submissionId) : undefined);
        break;
      case "upload_ack": {
        // The IRS acknowledgment is a DOCUMENT read by Clara (quarantined reader) and verified by code.
        if (limitedAck(id)) return NextResponse.json({ error: "Too many acknowledgment uploads; please wait a few minutes." }, { status: 429 });
        const ack = await import("@/lib/ack");
        try {
          if (body.sample) {
            if (!c.isDemo || c.paypalSim || (await db.auditEvent.findFirst({ where: { caseId: id, action: "platform_case_created" } })))
              return NextResponse.json({ error: "the sample acknowledgment is only for sandbox desk cases; upload the real acknowledgment" }, { status: 400 });
            // Rendered for this case's registered Submission ID, then read by the REAL reader like any upload.
            const s = await ack.sampleAckFor(id, body.sample === "rejected" ? "Rejected" : "Accepted");
            return NextResponse.json(await ack.verifyAcknowledgment(id, { bytes: s.bytes, mediaType: "application/pdf", filename: s.filename }, { via: "desk-sample" }));
          }
          const f = body.file as { base64?: unknown; mediaType?: unknown; name?: unknown } | undefined;
          const mt = String(f?.mediaType ?? "");
          if (!f || typeof f.base64 !== "string" || f.base64.length > MAX_UPLOAD_B64 || !(ack.ACK_TYPES as readonly string[]).includes(mt))
            return NextResponse.json({ error: "Upload the IRS e-file acknowledgment as a PDF, PNG or JPEG up to 10 MB." }, { status: 400 });
          const bytes = Buffer.from(f.base64, "base64");
          const magic = mt === "application/pdf" ? bytes.subarray(0, 5).toString("latin1") === "%PDF-" : mt === "image/png" ? bytes[0] === 0x89 : bytes[0] === 0xff && bytes[1] === 0xd8;
          if (!magic) return NextResponse.json({ error: `The file is not a valid ${mt}.` }, { status: 415 });
          return NextResponse.json(await ack.verifyAcknowledgment(id, { bytes, mediaType: mt, filename: String(f.name ?? "irs-ack").slice(0, 120) }, { via: "desk" }));
        } catch (e) {
          if (e instanceof ack.AckError) return NextResponse.json({ error: e.message }, { status: e.status });
          throw e;
        }
      }
      case "request_capture": {
        await audit(id, "user", "preparer_request_capture", { detail: { note: "Try to break it" } });
        const since = new Date();
        await runAgent(id, "preparer_request_capture");
        const g = await db.auditEvent.findFirst({
          where: { caseId: id, actor: "guardian", action: "capture_blocked", createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
        });
        const after2 = await db.case.findUniqueOrThrow({ where: { id } });
        return NextResponse.json(
          g ? { ok: false, blocked: (JSON.parse(g.detail) as { conditions: string[] }).conditions } : { ok: after2.state === "CAPTURED" },
        );
      }
      case "respond": {
        if (!(await engine.preparerResponseAllowed(id)))
          return NextResponse.json({ error: "the 72 h response window is closed or there is no proposal" }, { status: 409 });
        const text = String(body.text ?? "").trim().slice(0, 800);
        if (!text) return NextResponse.json({ error: "empty response" }, { status: 400 });
        await db.chatMessage.create({ data: { caseId: id, role: "preparer", text } });
        after(() => runAgent(id, "preparer_response", { text }));
        break;
      }
      case "advance_clock":
        await engine.advanceClock(id, Number(body.hours ?? 0) * H);
        break;
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const internal = /prisma|invalid `|ECONN|fetch failed|token|oauth|stack/i.test(msg) || msg.length > 240;
    if (internal) console.error("action error", msg);
    return NextResponse.json({ error: internal ? "Something went wrong. Please try again." : msg }, { status: 400 });
  }
}
