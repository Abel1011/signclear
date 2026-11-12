// Deterministic case engine (state machine). Money moves only through ./money.
import crypto from "node:crypto";
import { db } from "./db";
import { audit, notify } from "./audit";
import { now, H, D } from "./clock";
import { preFilingRules, verdict, r14, type Intake, type Values, type Finding } from "./rules";
import { toValues } from "./reader";
import { sumsOkAllCredits, normalizeTranscript } from "./rules-extra";
import { PREPARER, MARIA_INTAKE, MARIA_VALUES, MARIA_TRANSCRIPT, SUBMISSION_ID, DIVERSION_ACCT_LAST4, CACHED_READ_TEXT } from "./fixtures";
import * as money from "./money";
import { fmtUSD } from "./i18n";

const token = () => crypto.randomBytes(24).toString("base64url");

export async function getPreparer() {
  const p = await db.preparer.findFirst({ where: { ptin: PREPARER.ptin } });
  return p ?? db.preparer.create({ data: PREPARER });
}

export async function setState(caseId: string, to: string, extra: Record<string, unknown> = {}) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  await db.case.update({ where: { id: caseId }, data: { state: to, version: { increment: 1 }, ...extra } });
  await audit(caseId, "system", "state", { from: c.state, to });
}

export async function loadValues(caseId: string, kinds?: string[]): Promise<Values> {
  const rows = await db.extractedValue.findMany({ where: { caseId, ...(kinds ? { docKind: { in: kinds } } : {}) } });
  return toValues(rows);
}

export async function loadIntake(caseId: string): Promise<Intake> {
  const i = await db.intake.findUniqueOrThrow({ where: { caseId } });
  return JSON.parse(i.data) as Intake;
}

// ---------------------------------------------------------------- demo setup
export async function createDemoCase(session: string, scenario: "maria" | "casec", lang = "es") {
  const p = await getPreparer();
  const c = await db.case.create({
    data: {
      preparerId: p.id,
      clientName: scenario === "casec" ? "Carlos Ruiz" : MARIA_INTAKE.name,
      clientLang: lang,
      fee: 25_000,
      isDemo: true,
      demoSession: session,
      scenario,
      seasonOpen: new Date(Date.now() - 7 * D),
      clientToken: token(),
      preparerToken: token(),
    },
  });
  await audit(c.id, "system", "case_created", { to: "CASE_CREATED", detail: { scenario } });
  if (scenario === "casec") {
    await db.intake.create({ data: { caseId: c.id, data: JSON.stringify({ ...MARIA_INTAKE, name: "Carlos Ruiz", dependents: MARIA_INTAKE.dependents.slice(0, 2) }) } });
    await storeValues(c.id, "DRAFT_1040", { ...MARIA_VALUES, taxpayer_name: "Carlos Ruiz" });
    await setState(c.id, "MATCH");
  }
  return c;
}

/** A preparer opens a case in their sandbox session. Nothing is pre-filled: the client answers, the preparer uploads. */
export async function createCase(session: string, clientName: string, lang: string, feeCents: number, opts: { paypalSim?: boolean } = {}) {
  const p = await getPreparer();
  const c = await db.case.create({
    data: {
      preparerId: p.id,
      clientName,
      clientLang: lang,
      fee: feeCents,
      isDemo: true,
      demoSession: session,
      scenario: "live",
      paypalSim: !!opts.paypalSim,
      seasonOpen: new Date(Date.now() - 7 * D),
      clientToken: token(),
      preparerToken: token(),
    },
  });
  await audit(c.id, "user", "case_created", { to: "CASE_CREATED", detail: { by: "preparer" } });
  return c;
}

export async function storeValues(caseId: string, docKind: string, v: Values) {
  await db.extractedValue.deleteMany({ where: { caseId, docKind } });
  const rows = Object.entries(v).map(([label, val]) => ({
    caseId,
    docKind,
    form: docKind,
    line: "",
    label,
    value: typeof val === "number" ? (val / (label === "dependents_count" ? 1 : 100)).toString() : String(val),
    page: 1,
  }));
  if (rows.length) await db.extractedValue.createMany({ data: rows });
}

// ------------------------------------------------------------------ client flow
export async function submitIntake(caseId: string, intake: Intake, consents: { review: boolean; other: boolean }) {
  if (!consents.review) throw new Error("review consent required");
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  const existing = await db.intake.findUnique({ where: { caseId } });
  if (existing && ["CLARIFY", "DIFFERENCES"].includes(c.state)) {
    const hist = JSON.parse(existing.history) as unknown[];
    hist.push({ at: new Date().toISOString(), before: JSON.parse(existing.data), after: intake });
    await db.intake.update({ where: { caseId }, data: { data: JSON.stringify(intake), history: JSON.stringify(hist) } });
    await audit(caseId, "user", "intake_changed_after_findings", { detail: { changes: hist.length } });
    return review(caseId);
  }
  await db.intake.upsert({
    where: { caseId },
    create: { caseId, data: JSON.stringify(intake) },
    update: { data: JSON.stringify(intake) },
  });
  await audit(caseId, "user", "consent_and_intake", { detail: consents });
  if (c.state === "CASE_CREATED") await setState(caseId, "CONSENTED");
}

/** Preparer uploads draft + unsigned 8879. In demo we replay the cached extraction of the sample PDFs. */
export async function uploadDraft(caseId: string, live?: { base64: string; mediaType: string }) {
  const before = (await db.case.findUniqueOrThrow({ where: { id: caseId } })).state;
  await setState(caseId, "PROCESSING");
  if (live) {
    const { readDocumentLive } = await import("./reader");
    let r: Awaited<ReturnType<typeof readDocumentLive>>;
    try {
      r = await readDocumentLive(live, AbortSignal.timeout(90_000));
    } catch (e) {
      await setState(caseId, before); // never leave the case stuck in PROCESSING
      await audit(caseId, "ai", "read_document_failed", { detail: { error: String(e).slice(0, 200) } });
      throw new Error("We couldn't read that document. Please upload a clear PDF or photo of the return.");
    }
    await db.extractedValue.deleteMany({ where: { caseId, docKind: "DRAFT_1040" } });
    await db.extractedValue.createMany({ data: r.rows.map((x) => ({ caseId, docKind: "DRAFT_1040", ...x })) });
    await audit(caseId, "ai", "read_document", { detail: { model: r.model, latencyMs: r.latencyMs, fields: r.rows.length, usage: r.usage } });
  } else {
    await storeValues(caseId, "DRAFT_1040", MARIA_VALUES);
    await audit(caseId, "ai", "read_document", { detail: { mode: "cached", fields: Object.keys(MARIA_VALUES).length, text: CACHED_READ_TEXT(Object.keys(MARIA_VALUES).length) } });
  }
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  await notify(caseId, "client", {
    es: `${PREPARER.name} subió su declaración. Ya puede revisarla.`,
    en: `${PREPARER.name} uploaded your return. You can review it now.`,
    pt: `${PREPARER.name} enviou sua declaração. Já pode revisá-la.`,
  });
  void c;
  return review(caseId);
}

export async function review(caseId: string) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId }, include: { preparer: true } });
  const intake = await loadIntake(caseId);
  const v = await loadValues(caseId, ["DRAFT_1040"]);
  v.sums_ok = sumsOkAllCredits(v);
  const findings = preFilingRules(intake, v, c.preparer.ptin);
  await db.finding.deleteMany({ where: { caseId, rule: { not: "R14" } } });
  if (findings.length)
    await db.finding.createMany({
      data: findings.map((f) => ({ caseId, rule: f.rule, severity: f.severity, rowKey: f.rowKey, message: JSON.stringify(f.message) })),
    });
  const v2 = verdict(findings);
  await audit(caseId, "rules", "rules_evaluated", { detail: { findings: findings.map((f) => `${f.rule}:${f.severity}`), verdict: v2 } });
  await setState(caseId, v2);
  return { verdict: v2, findings };
}

export async function acceptClarifications(caseId: string) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  if (c.state !== "CLARIFY") return;
  await db.finding.updateMany({ where: { caseId, severity: "CLARIFY" }, data: { resolved: true } });
  await audit(caseId, "user", "clarifications_accepted");
  await setState(caseId, "MATCH");
}

// --------------------------------------------------------------- after approval
/** Atomic, state-checked transition. Returns false if the case was not in an allowed state. */
export async function transition(caseId: string, from: string[], to: string, extra: Record<string, unknown> = {}) {
  const r = await db.case.updateMany({ where: { id: caseId, state: { in: from } }, data: { state: to, version: { increment: 1 }, ...extra } });
  if (r.count === 1) await audit(caseId, "system", "state", { from: from.join("|"), to });
  return r.count === 1;
}

export async function snapshot(caseId: string) {
  const v = await loadValues(caseId, ["DRAFT_1040"]);
  await db.approvedSnapshot.upsert({
    where: { caseId },
    create: { caseId, data: JSON.stringify(v) },
    update: { data: JSON.stringify(v) },
  });
}

export async function registerTransmission(caseId: string, submissionId?: string) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  const sid = submissionId ?? (c.isDemo ? SUBMISSION_ID : undefined);
  // IRS Pub 4164: Submission ID = EFIN of the transmitting ERO (6) + processing year ccyy (4) + day of year (3) + 7 alphanumerics.
  if (!sid || !/^\d{6}\d{4}\d{3}[0-9a-z]{7}$/.test(sid)) throw new Error("Submission ID must be 20 characters: EFIN + year + day + 7 letters/digits");
  if (!sid.startsWith(PREPARER.efin)) throw new Error(`Submission ID must start with the ERO's EFIN (${PREPARER.efin})`);
  if (sid.slice(6, 10) !== String(now(c).getFullYear())) throw new Error(`Submission ID must carry the current processing year (${now(c).getFullYear()})`);
  if (c.state === "TRANSMITTED") {
    // Retransmission after a VERIFIED IRS rejection of the current submission, still before the deadline.
    const { currentSubmissionRejected } = await import("./ack");
    if (c.ackReceivedAt || !(await currentSubmissionRejected(caseId, c.submissionId)))
      throw new Error("cannot file in state TRANSMITTED: a new Submission ID is only accepted after the IRS rejected the current one");
    if (c.ackDeadline && now(c) > c.ackDeadline) throw new Error("the deadline for the IRS confirmation has passed");
    if (sid === c.submissionId) throw new Error("a retransmission gets a new Submission ID");
    const r = await db.case.updateMany({
      where: { id: caseId, state: "TRANSMITTED", submissionId: c.submissionId, ackReceivedAt: null },
      data: { submissionId: sid, transmittedAt: now(c), version: { increment: 1 } },
    });
    if (r.count !== 1) throw new Error("concurrent update");
    await audit(caseId, "user", "retransmitted_after_rejection", { detail: { previous: c.submissionId, submissionId: sid } });
    return;
  }
  if (!(await transition(caseId, ["AUTHORIZED"], "TRANSMITTED", { submissionId: sid, transmittedAt: now(c) })))
    throw new Error(`cannot file in state ${c.state}`);
  await notify(caseId, "client", {
    es: `${PREPARER.name} envió su declaración al IRS. Ya no se puede cancelar el apartado.`,
    en: `${PREPARER.name} filed your return with the IRS. The hold can no longer be cancelled.`,
    pt: `${PREPARER.name} enviou sua declaração ao IRS. A reserva não pode mais ser cancelada.`,
  });
}

/** Preparer uploads the IRS e-file acknowledgment DOCUMENT. It is read by the quarantined reader and verified by code
 *  (status, Submission ID, EFIN, tax year, taxpayer, date) before the money guardian is asked to capture.
 *  Without a file (internal demo seeding only): a server-rendered sample acknowledgment for the registered Submission ID,
 *  whose printed values are known, goes through the same verification. */
export async function ackReceived(caseId: string, file?: { bytes: Buffer; mediaType: string; filename?: string }, via = "desk") {
  const ack = await import("./ack");
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  if (c.state !== "TRANSMITTED" || c.ackReceivedAt) return { ok: false, blocked: [`IRS confirmation not accepted in state ${c.state}`] };
  try {
    if (file) return await ack.verifyAcknowledgment(caseId, file, { via });
    if (!c.isDemo) return { ok: false, blocked: ["R13: upload the IRS e-file acknowledgment document"] };
    const s = await ack.sampleAckFor(caseId);
    return await ack.verifyAcknowledgment(caseId, { bytes: s.bytes, mediaType: "application/pdf", filename: s.filename }, { via: "seed", known: s.truth });
  } catch (e) {
    if (e instanceof ack.AckError) return { ok: false, blocked: [e.message] };
    throw e;
  }
}

export async function reportRefund(caseId: string, receivedCents: number) {
  if (!Number.isFinite(receivedCents) || receivedCents < 0) throw new Error("invalid amount");
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId }, include: { snapshot: true } });
  if (c.state !== "CAPTURED") throw new Error(`refund can only be reported after the fee was collected (state ${c.state})`);
  const snap = JSON.parse(c.snapshot?.data ?? "{}") as Values;
  if (snap.refund === undefined) throw new Error("no approved snapshot");
  if (Math.abs(receivedCents - snap.refund) <= 1400) {
    if (!(await transition(caseId, ["CAPTURED"], "CLOSED", { refundReportedAmount: receivedCents }))) throw new Error("concurrent update");
    return { matched: true };
  }
  if (!(await transition(caseId, ["CAPTURED"], "INVESTIGATING", { refundReportedAmount: receivedCents, preparerVerdict: null, clientConfirmedRefund: false })))
    throw new Error("concurrent update");
  await storeValues(caseId, "DEPOSIT", { deposit_received: receivedCents });
  return { matched: false, approved: snap.refund };
}

/** Where the IRS actually sent the refund, per the filed return's Form 8888 (from the IRS refund deposit record).
 *  Stored as its own document kind so it never mixes with the 1040 values. */
export type FiledSplit = { acct: string; amount: number; mainAcct: string; mainAmount: number };

export async function loadFiledSplit(caseId: string): Promise<FiledSplit | null> {
  const row = await db.extractedValue.findFirst({ where: { caseId, docKind: "FILED_8888", label: "split" } });
  if (!row) return null;
  try {
    const s = JSON.parse(row.value) as FiledSplit;
    return /^\d{4}$/.test(s.acct) && Number.isFinite(s.amount) && s.amount > 0 ? s : null;
  } catch {
    return null;
  }
}

export async function uploadTranscript(caseId: string) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  if (c.state !== "INVESTIGATING") throw new Error(`no investigation open (state ${c.state})`);
  if (!c.isDemo) throw new Error("live transcript upload requires a document");
  // SIMULATED IRS records: the account transcript shows the IRS issued exactly the approved refund (code 846) with
  // no offsets (no 826/898). The refund deposit record shows the FILED return carried a Form 8888 that split the
  // missing part to another account (****9931) — a split that is not in the version the client approved.
  const snap = JSON.parse((await db.approvedSnapshot.findUnique({ where: { caseId } }))?.data ?? "{}") as Values;
  await storeValues(caseId, "TRANSCRIPT", snap.refund !== undefined ? { ...MARIA_TRANSCRIPT, tx_806: snap.withholding ?? 0, tx_846: snap.refund } : MARIA_TRANSCRIPT);
  const deposit = (await loadValues(caseId, ["DEPOSIT"])).deposit_received;
  await db.extractedValue.deleteMany({ where: { caseId, docKind: "FILED_8888" } });
  if (snap.refund !== undefined && deposit !== undefined && deposit + 1400 < snap.refund) {
    const split: FiledSplit = { acct: DIVERSION_ACCT_LAST4, amount: snap.refund - deposit, mainAcct: snap.refund_acct_last4 ?? "—", mainAmount: deposit };
    await db.extractedValue.create({ data: { caseId, docKind: "FILED_8888", form: "8888", line: "1-3", label: "split", value: JSON.stringify(split), page: 1 } });
  }
  await audit(caseId, "ai", "read_document", {
    detail: { kind: "IRS account transcript + refund deposit record", mode: "cached", simulated: true, text: "Simulated IRS transcript and deposit record (sample data, no AI call) · SIMULATED" },
  });
  // Deterministic: the engine evaluates R14 and opens the proposal; the agent only explains.
  return proposeRefund(caseId, "R14: IRS transcript vs. approved snapshot");
}

/** R14 plus the concrete evidence, in plain words: transcript codes, the accounts, and what the client approved. */
export async function compareTranscript(caseId: string) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId }, include: { snapshot: true } });
  const snap = JSON.parse(c.snapshot?.data ?? "{}") as Values;
  const v = { ...(await loadValues(caseId, ["TRANSCRIPT", "DEPOSIT"])) };
  if (v.tx_846 === undefined || snap.refund === undefined) return { verdict: "NO_TRANSCRIPT" as const };
  const res = r14(snap, normalizeTranscript(v)); // real transcripts print 806/768 as negatives
  await audit(caseId, "rules", "R14_compare_transcript", { detail: { verdict: res.verdict } });
  if (res.verdict !== "DIVERTED") return res;
  const split = await loadFiledSplit(caseId);
  return { ...res, detail: diversionText(snap, normalizeTranscript(v), split, res.detail), split };
}

/** The diversion story with its evidence. Without a deposit record it falls back to R14's own wording. */
export function diversionText(snap: Values, v: Values, split: FiledSplit | null, base: { es: string; en: string; pt: string }) {
  if (!split || v.tx_846 === undefined || v.deposit_received === undefined) return base;
  const issued = fmtUSD(v.tx_846), got = fmtUSD(v.deposit_received), amt = fmtUSD(split.amount);
  const mine = snap.refund_acct_last4 ?? split.mainAcct;
  const approvedSplit = !!snap.f8888_multiple;
  return {
    es: `El registro del IRS (código 846) muestra que emitió ${issued}, sin compensaciones por deudas (sin códigos 826/898). A su cuenta ****${mine} llegaron ${got}. La declaración que se presentó llevaba un Formulario 8888 que mandó ${amt} a la cuenta ****${split.acct}. ${approvedSplit ? "La versión que usted aprobó también repartía el reembolso; confirme si ****" + split.acct + " es suya." : `La versión que usted aprobó no tenía Formulario 8888: enviaba los ${fmtUSD(snap.refund ?? v.tx_846)} a ****${mine}. Ese reparto se añadió después de su aprobación.`}`,
    en: `The IRS record (code 846) shows it issued ${issued}, with no debt offsets (no codes 826/898). ${got} reached your account ****${mine}. The return that was filed carried a Form 8888 that sent ${amt} to account ****${split.acct}. ${approvedSplit ? `The version you approved also split the refund; confirm whether ****${split.acct} is yours.` : `The version you approved had no Form 8888: it sent all ${fmtUSD(snap.refund ?? v.tx_846)} to ****${mine}. That split was added after you approved it.`}`,
    pt: `O registro do IRS (código 846) mostra que emitiu ${issued}, sem compensações por dívidas (sem códigos 826/898). Na sua conta ****${mine} chegaram ${got}. A declaração enviada tinha um Formulário 8888 que mandou ${amt} para a conta ****${split.acct}. ${approvedSplit ? `A versão que você aprovou também dividia o reembolso; confirme se ****${split.acct} é sua.` : `A versão que você aprovou não tinha Formulário 8888: enviava os ${fmtUSD(snap.refund ?? v.tx_846)} para ****${mine}. Essa divisão foi adicionada depois da sua aprovação.`}`,
  };
}

export async function proposeRefund(caseId: string, rationale: string) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  if (c.state !== "INVESTIGATING") return { ok: false, blocked: [`state ${c.state}`] };
  const res = await compareTranscript(caseId);
  if (!("detail" in res)) return { ok: false, blocked: ["no transcript on file"] };
  if (res.verdict !== "SUBSTITUTED" && res.verdict !== "DIVERTED") {
    if (await transition(caseId, ["INVESTIGATING"], "CLOSED")) await notify(caseId, "client", res.detail);
    return { ok: false, blocked: [`R14: ${res.verdict}`] };
  }
  const ok = await transition(caseId, ["INVESTIGATING"], "REFUND_PROPOSED", {
    refundDeadline: new Date(now(c).getTime() + 72 * H),
    preparerVerdict: null,
    clientConfirmedRefund: false,
  });
  if (!ok) return { ok: false, blocked: ["concurrent update"] };
  await db.finding.create({ data: { caseId, rule: "R14", severity: "IMPORTANT", rowKey: "refund", message: JSON.stringify(res.detail) } });
  await audit(caseId, "rules", "propose_refund", { rationale });
  const split = "split" in res ? res.split : null;
  const why = split
    ? { es: ` El 8888 presentado mandó ${fmtUSD(split.amount)} a ****${split.acct}, que no estaba en la versión aprobada.`, en: ` The filed Form 8888 sent ${fmtUSD(split.amount)} to ****${split.acct}, which was not in the approved version.`, pt: ` O 8888 enviado mandou ${fmtUSD(split.amount)} para ****${split.acct}, que não estava na versão aprovada.` }
    : { es: "", en: "", pt: "" };
  await notify(caseId, "preparer", {
    es: `Propuesta de devolución para ${c.clientName}.${why.es} Tiene 72 h para responder con evidencia.`,
    en: `Refund proposed for ${c.clientName}.${why.en} You have 72 h to respond with evidence.`,
    pt: `Devolução proposta para ${c.clientName}.${why.pt} Você tem 72 h para responder com evidências.`,
  });
  return { ok: true };
}

/** Records the evaluation of the preparer's response. Never overwrites a verdict. A refutation is not
 *  final: it sends the case to human review (UNRESOLVED), so a prompt-injected "REFUTED" cannot block the client. */
export async function setPreparerVerdict(caseId: string, verdictV: "REFUTED" | "NOT_REFUTED" | "INCONCLUSIVE", rationale: string, actor: "ai" | "system" = "ai") {
  const r = await db.case.updateMany({
    where: { id: caseId, state: "REFUND_PROPOSED", preparerVerdict: null },
    data: { preparerVerdict: verdictV, version: { increment: 1 } },
  });
  if (r.count !== 1) return false;
  await audit(caseId, actor, "evaluate_preparer_response", { rationale, detail: { verdict: verdictV } });
  // Evidence from the preparer → human review for up to 5 days; the sweeper returns the case to the client after that.
  if (verdictV === "REFUTED") {
    const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
    await transition(caseId, ["REFUND_PROPOSED"], "UNRESOLVED", { refundDeadline: new Date(now(c).getTime() + 5 * D) });
  }
  if (verdictV === "INCONCLUSIVE")
    await notify(caseId, "client", {
      es: "Su preparador respondió, pero no explica por qué el dinero no llegó. Al terminar las 72 h podrá confirmar la devolución.",
      en: "Your preparer replied, but it doesn't explain why the money didn't arrive. When the 72 h end you can confirm the refund.",
      pt: "Seu preparador respondeu, mas não explica por que o dinheiro não chegou. Ao fim das 72 h você poderá confirmar a devolução.",
    });
  return true;
}

export async function preparerResponseAllowed(caseId: string) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  return c.state === "REFUND_PROPOSED" && !c.preparerVerdict && !!c.refundDeadline && now(c) < c.refundDeadline;
}

export async function clientConfirmRefund(caseId: string) {
  const r = await db.case.updateMany({ where: { id: caseId, state: "REFUND_PROPOSED" }, data: { clientConfirmedRefund: true, version: { increment: 1 } } });
  if (r.count !== 1) return { ok: false, blocked: ["no refund proposal open"] };
  await audit(caseId, "user", "client_confirmed_refund");
  return money.refund(caseId, "system", "Client confirmed; preparer did not refute within 72 h");
}

// ------------------------------------------------------------- clock + sweeper
export async function advanceClock(caseId: string, ms: number) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  if (!c.isDemo) throw new Error("clock simulation only for demo cases");
  if (!Number.isFinite(ms) || ms <= 0 || ms > 30 * D) throw new Error("invalid clock step");
  await db.case.update({ where: { id: caseId }, data: { clockOffsetMs: c.clockOffsetMs + ms } });
  await audit(caseId, "system", "clock_advanced", { detail: { hours: ms / H, simulated: true } });
  await sweepCase(caseId, { force: true });
}

const STALE_MS = 2 * 60_000;

export async function sweepCase(caseId: string, opts: { force?: boolean } = {}) {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  const t = now(c);
  const lateOrMissingAck = !c.ackReceivedAt || (!!c.ackDeadline && c.ackReceivedAt > c.ackDeadline);
  if (["AUTHORIZED", "TRANSMITTED"].includes(c.state) && c.ackDeadline && t > c.ackDeadline && lateOrMissingAck)
    await money.voidAuth(caseId, "deadline passed without IRS confirmation");
  else if (["AUTHORIZED", "TRANSMITTED"].includes(c.state) && c.approvedAt && t.getTime() > c.approvedAt.getTime() + 3 * D && !c.ackReceivedAt) {
    // Day 4+: PayPal's 3-day honor period is over; refresh it once so the capture stays guaranteed.
    // Try once per simulated day-4 crossing; PayPal refuses while still inside the real-time honor period.
    if (!(await db.auditEvent.findFirst({ where: { caseId, action: "reauthorize" } }))) await money.reauthorize(caseId);
  }
  if (c.state === "UNRESOLVED" && c.refundDeadline && t >= c.refundDeadline) {
    // No human decision within the review window: the client is not left waiting forever.
    if (await transition(caseId, ["UNRESOLVED"], "REFUND_PROPOSED", { preparerVerdict: "INCONCLUSIVE" }))
      await audit(caseId, "system", "human_review_window_expired");
  }
  if (c.state === "REFUND_PROPOSED" && c.refundDeadline && t >= c.refundDeadline && c.preparerVerdict !== "NOT_REFUTED") {
    if (!c.preparerVerdict) await setPreparerVerdict(caseId, "NOT_REFUTED", "No response from the preparer within 72 h", "system");
    if (c.clientConfirmedRefund) await money.refund(caseId, "system", "Client had already confirmed; 72 h passed");
    else if (!(await db.auditEvent.findFirst({ where: { caseId, action: "refund_window_closed" } }))) {
      await audit(caseId, "system", "refund_window_closed");
      await notify(caseId, "client", {
        es: `${PREPARER.name} no respondió en 72 h. Confirme para recibir la devolución de ${fmtUSD(c.fee)}.`,
        en: `${PREPARER.name} did not respond within 72 h. Confirm to receive the ${fmtUSD(c.fee)} refund.`,
        pt: `${PREPARER.name} não respondeu em 72 h. Confirme para receber a devolução de ${fmtUSD(c.fee)}.`,
      });
    }
  }
  // Retries of in-flight PayPal calls: only when the original request has clearly stalled.
  const stale = !opts.force && Date.now() - c.updatedAt.getTime() > STALE_MS;
  if (stale && c.state === "CAPTURE_PENDING") await money.finishCapture(caseId);
  if (stale && c.state === "VOID_PENDING") await money.finishVoid(caseId);
  if (stale && c.state === "REFUND_PENDING") await money.finishRefund(caseId);
  // Fee lines (state return): deadline release, stalled partial captures.
  await money.sweepLines(caseId, { force: false });
}

export async function sweepAll() {
  const open = await db.case.findMany({
    where: { state: { in: ["AUTHORIZED", "TRANSMITTED", "REFUND_PROPOSED", "UNRESOLVED", "CAPTURE_PENDING", "VOID_PENDING", "REFUND_PENDING"] } },
    select: { id: true },
  });
  for (const c of open) {
    try {
      await sweepCase(c.id);
    } catch (e) {
      console.error("sweep", c.id, e);
    }
  }
  await money.sweepAllLines(); // state-return fee lines of already-captured cases
}

export type { Finding };
