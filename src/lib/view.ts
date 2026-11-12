import { db } from "./db";
import { buildRows } from "./rows";
import { loadIntake, loadValues, loadFiledSplit } from "./engine";
import { captureConditions, refundConditions } from "./money";
import { now } from "./clock";
import { accuracy } from "./reader";
import { MARIA_VALUES } from "./fixtures";
import { lastAckView } from "./ack";
import type { Finding, Values } from "./rules";

export type Role = "client" | "preparer";

export async function resolveToken(token: string): Promise<{ caseId: string; role: Role } | null> {
  const c = await db.case.findFirst({
    where: { OR: [{ clientToken: token }, { preparerToken: token }] },
    select: { id: true, clientToken: true },
  });
  if (!c) return null;
  return { caseId: c.id, role: c.clientToken === token ? "client" : "preparer" };
}

export async function caseView(caseId: string, role: Role) {
  const c = await db.case.findUniqueOrThrow({
    where: { id: caseId },
    include: { payment: true, preparer: true, findings: true, snapshot: true },
  });
  const intake = await loadIntake(caseId).catch(() => null);
  const v = await loadValues(caseId, ["DRAFT_1040"]);
  const post = await loadValues(caseId, ["TRANSCRIPT", "DEPOSIT"]);
  const findings: Finding[] = c.findings
    .filter((f) => !f.resolved)
    .map((f) => ({ rule: f.rule, severity: f.severity as Finding["severity"], rowKey: f.rowKey, message: JSON.parse(f.message) }));
  const confirmed = c.findings.filter((f) => f.resolved && f.severity === "CLARIFY").length;
  const hasDraft = Object.keys(v).length > 0;
  const confirmedKeys = new Set(c.findings.filter((f) => f.resolved && f.severity === "CLARIFY").map((f) => f.rowKey));
  const snapshot = c.snapshot ? (JSON.parse(c.snapshot.data) as Values) : (v as Values);
  const split = post.tx_846 !== undefined ? await loadFiledSplit(caseId) : null;
  const rows0 =
    intake && hasDraft
      ? buildRows(intake, { ...v, ...post }, findings, post.tx_846 !== undefined || post.deposit_received !== undefined ? { snapshot, split } : undefined, c.clientLang as "es" | "en" | "pt")
      : [];
  const rows = rows0.map((r) => (confirmedKeys.has(r.key) && r.status === "MATCH" ? { ...r, status: "CONFIRMED" as const } : r));
  const [notifications, chat, reviewEvents] = await Promise.all([
    db.notification.findMany({ where: { caseId, audience: role }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.chatMessage.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.auditEvent.findMany({ where: { caseId, action: { in: ["rules_evaluated", "clarifications_accepted"] } }, orderBy: { createdAt: "asc" }, select: { action: true, createdAt: true, detail: true } }),
  ]);
  // Each rules review (or the client's confirmation of a clarification) opens a new "chapter" of the chat:
  // drafts and warnings from an earlier chapter that had differences are shown as resolved, not as live.
  const reviews = reviewEvents.map((e) => ({
    at: e.createdAt,
    verdict: e.action === "clarifications_accepted" ? "MATCH" : String((JSON.parse(e.detail) as { verdict?: string }).verdict ?? ""),
  }));
  const OPEN_REVIEW = ["CLARIFY", "DIFFERENCES", "NEEDS_CONFIRMATION"];
  const latestOk = (reviews[reviews.length - 1]?.verdict ?? "") === "MATCH" || !OPEN_REVIEW.includes(c.state);
  /** "resolved": a warning/draft from a review whose differences were later cleared; "earlier": superseded by a
   *  newer review that still has differences. null: current. Only Clara's messages and drafts are marked. */
  const staleness = (at: Date, role: string, text: string): "resolved" | "earlier" | null => {
    if (role !== "agent") return null;
    let i = -1;
    for (let k = 0; k < reviews.length; k++) if (reviews[k].at <= at) i = k;
    if (i < 0) return null;
    const later = i < reviews.length - 1;
    const chapterHadIssues = reviews[i].verdict !== "MATCH";
    const draft = text.startsWith("__QUESTIONS__");
    const approved = !["CASE_CREATED", "CONSENTED", "PROCESSING", ...OPEN_REVIEW, "MATCH"].includes(c.state);
    if (!later && !(chapterHadIssues && !OPEN_REVIEW.includes(c.state)) && !(draft && approved)) return null;
    if (!chapterHadIssues && !draft) return null;
    return latestOk ? "resolved" : "earlier";
  };
  const intakeRow = await db.intake.findUnique({ where: { caseId } });
  const changes = intakeRow ? (JSON.parse(intakeRow.history) as unknown[]).length : 0;
  const t = now(c);
  return {
    id: c.id,
    role,
    state: c.state,
    scenario: c.scenario,
    isDemo: c.isDemo,
    lang: c.clientLang,
    clientName: c.clientName,
    fee: c.fee,
    preparer: { name: c.preparer.name, business: c.preparer.business, ptin: c.preparer.ptin, efin: c.preparer.efin },
    intake,
    intakeChanges: changes,
    rows,
    findings,
    confirmed,
    payment: c.payment,
    r15: c.r15Flag,
    ackDeadline: c.ackDeadline,
    refundDeadline: c.refundDeadline,
    now: t,
    clockOffsetHours: Math.round(c.clockOffsetMs / 3600_000),
    submissionId: c.submissionId,
    ackReceivedAt: c.ackReceivedAt,
    lastAck: role === "preparer" ? await lastAckView(caseId) : null,
    preparerVerdict: c.preparerVerdict,
    approvedRefund: c.snapshot ? (JSON.parse(c.snapshot.data) as Values).refund ?? null : null,
    reportedRefund: c.refundReportedAmount,
    hasTranscript: post.tx_846 !== undefined,
    accuracy: hasDraft ? accuracy(v, MARIA_VALUES) : null,
    guards: {
      capture: c.payment ? captureConditions(c) : ["no payment"],
      refund: c.payment ? refundConditions(c) : ["no payment"],
    },
    refundWindowOpen: !!c.refundDeadline && t < c.refundDeadline,
    /** Sample/judge-seat case: the sandbox test buyer pays, so "paid by someone else" notes don't apply. */
    sample: !!c.scenario && (c.scenario.startsWith("seat-") || c.scenario === "maria" || c.scenario === "casec" || /^(maría|maria) gonz[aá]lez$|^carlos ruiz$/i.test(c.clientName.trim())),
    diversion: split,
    notifications: notifications.map((n) => ({ id: n.id, text: JSON.parse(n.text), read: n.read, at: n.createdAt })),
    chat: chat.map((m) => ({ id: m.id, role: m.role, text: m.text, focusRow: m.focusRow, at: m.createdAt, stale: staleness(m.createdAt, m.role, m.text) })),
    tokens: role === "preparer" ? { client: c.clientToken, preparer: c.preparerToken } : undefined,
  };
}

export async function auditView(caseId: string) {
  const ev = await db.auditEvent.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  return ev.map((e) => ({
    id: e.id,
    at: e.createdAt,
    actor: e.actor,
    action: e.action,
    rationale: e.rationale,
    from: e.fromState,
    to: e.toState,
    debugId: e.debugId,
    detail: JSON.parse(e.detail),
  }));
}
