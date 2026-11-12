// "Watch SignClear in 90 seconds": the whole story driven step by step on ONE real case.
// Every step calls the same engine / money functions the buttons call (real rules, real PayPal sandbox);
// nothing here fakes a state. Steps are idempotent: a step whose outcome is already on file is a no-op,
// so the judge can take over, click by hand, and hand control back at any point.
import * as engine from "./engine";
import * as money from "./money";
import { db } from "./db";
import { audit } from "./audit";
import { MARIA_DEPOSIT } from "./fixtures";

import { TOUR_STEPS } from "./tour-steps";
export { TOUR_STEPS } from "./tour-steps";
export type { TourStep, TourScreen } from "./tour-steps";

const ORDER = ["CASE_CREATED", "CONSENTED", "PROCESSING", "CLARIFY", "DIFFERENCES", "MATCH", "AUTHORIZED", "TRANSMITTED", "CAPTURE_PENDING", "CAPTURED", "INVESTIGATING", "REFUND_PROPOSED", "REFUND_PENDING", "REFUNDED"];
export const reached = (state: string, s: string) => ORDER.indexOf(state) >= ORDER.indexOf(s);

export type StepResult = { ok: boolean; state: string; already?: boolean; blocked?: string[]; kick?: { event: "refund_reported" | "evidence_uploaded" | "review_ready"; payload?: Record<string, unknown> } };

/** Which story step the case is waiting for (TOUR_STEPS.length = finished). Used to resume and to validate skips. */
export async function tourPosition(caseId: string): Promise<number> {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
  const s = c.state;
  if (s === "REFUNDED" || s === "REFUND_PENDING") return TOUR_STEPS.length;
  if (s === "REFUND_PROPOSED") return (await windowClosed(caseId)) ? 9 : 8;
  if (s === "INVESTIGATING") return 7;
  if (reached(s, "CAPTURED")) return 6;
  if (s === "TRANSMITTED") return (await earlyRefused(caseId)) ? 5 : 4;
  if (s === "AUTHORIZED") return 3;
  if (s === "MATCH") return 2;
  return 1;
}

const earlyRefused = async (caseId: string) => !!(await db.auditEvent.findFirst({ where: { caseId, actor: "guardian", action: "capture_blocked" } }));
const windowClosed = async (caseId: string) =>
  !!(await db.auditEvent.findFirst({ where: { caseId, action: { in: ["refund_window_closed", "evaluate_preparer_response"] } } }));

/** Runs one story step (1..9; step 0 is seeding). Deterministic engine calls only; the agent explains afterwards. */
export async function runTourStep(caseId: string, step: number): Promise<StepResult> {
  const st = async () => (await db.case.findUniqueOrThrow({ where: { id: caseId } })).state;
  const s0 = await st();
  const pos = await tourPosition(caseId);
  if (step < pos) return { ok: true, already: true, state: s0 };
  if (step > pos) return { ok: false, state: s0, blocked: [`step ${TOUR_STEPS[pos]?.title ?? pos} comes first`] };
  switch (TOUR_STEPS[step]?.id) {
    case "corrected": {
      // The honest version of the return (refund to ****1234): cached read of the sample PDF + the real rules.
      await engine.uploadDraft(caseId);
      if ((await st()) === "CLARIFY") await engine.acceptClarifications(caseId);
      const s = await st();
      return { ok: s === "MATCH", state: s, blocked: s === "MATCH" ? undefined : [`rules verdict ${s}`], kick: { event: "review_ready" } };
    }
    case "approve": {
      const r = await money.seatAuthorize(caseId);
      return { ok: r.ok, state: await st(), blocked: r.blocked };
    }
    case "file":
      await engine.registerTransmission(caseId);
      return { ok: true, state: await st() };
    case "early": {
      await audit(caseId, "user", "preparer_request_capture", { detail: { note: "90-second story: Luis asks to be paid before the IRS confirms" } });
      const g = await money.capture(caseId, "ai", "Preparer asked to be paid now, before any IRS acknowledgment");
      // A refusal is the expected outcome; `ok` means the step ran.
      return { ok: !g.ok, state: await st(), blocked: g.blocked };
    }
    case "ack": {
      const r = await engine.ackReceived(caseId);
      return { ok: r.ok, state: await st(), blocked: r.blocked };
    }
    case "short": {
      const r = await engine.reportRefund(caseId, MARIA_DEPOSIT);
      return { ok: !r.matched, state: await st(), kick: r.matched ? undefined : { event: "refund_reported", payload: { received: MARIA_DEPOSIT, approved: r.approved } } };
    }
    case "transcript": {
      const r = await engine.uploadTranscript(caseId);
      return { ok: r.ok, state: await st(), blocked: r.blocked, kick: { event: "evidence_uploaded", payload: { proposed: r.ok } } };
    }
    case "clock":
      await engine.advanceClock(caseId, 73 * 3600_000);
      return { ok: await windowClosed(caseId), state: await st() };
    case "refund": {
      const r = await engine.clientConfirmRefund(caseId);
      return { ok: r.ok, state: await st(), blocked: r.blocked };
    }
  }
  return { ok: false, state: s0, blocked: ["unknown step"] };
}
