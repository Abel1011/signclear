// Judge seats: one click puts a visitor inside a sample case at its most interesting moment.
// Every case is built with the REAL engine (intake → draft → rules → PayPal → filing), never with fake UI state.
import * as engine from "../../../../lib/engine";
import { db } from "../../../../lib/db";
import { audit, notify } from "../../../../lib/audit";
import { MARIA_SEAT_INTAKE, MARIA_VALUES, MARIA_FRAUD_VALUES, MARIA_DEPOSIT, PREPARER, CACHED_READ_TEXT } from "../../../../lib/fixtures";
import type { Values } from "../../../../lib/rules";

export const SEATS = ["fraud", "clean", "collect", "short"] as const;
export type Seat = (typeof SEATS)[number];
export const isSeat = (s: unknown): s is Seat => SEATS.includes(s as Seat);
export const seatOf = (scenario: string | null | undefined): Seat | null => {
  const s = scenario?.startsWith("seat-") ? scenario.slice(5) : null;
  return isSeat(s) ? s : null;
};

/** Agent events the caller should run after the response (Clara explaining the case). */
export type AgentKick = { caseId: string; event: "review_ready" | "refund_reported"; payload?: Record<string, unknown> };

export type SeatResult = {
  seat: Seat;
  /** The state the seat aimed for. `reached` is false when a dependency (seatAuthorize) was missing. */
  target: string;
  reached: boolean;
  state: string;
  note?: string;
  case: { name: string; client: string; preparer: string };
  kicks: AgentKick[];
};

type SeatAuthorize = (caseId: string) => Promise<{ ok: boolean; blocked?: string[] }>;

/** Builder C's sandbox authorization (vaulted test wallet). Looked up at runtime so seats degrade gracefully. */
export async function findSeatAuthorize(): Promise<SeatAuthorize | null> {
  const mod = await import("../../../../lib/money");
  const fn = Reflect.get(mod, "seatAuthorize");
  return typeof fn === "function" ? (fn as SeatAuthorize) : null;
}

/** Same as engine.uploadDraft's cached path, with the seat's sample values (honest or fraud). */
async function replayDraft(caseId: string, values: Values, sample: string) {
  await engine.setState(caseId, "PROCESSING");
  await engine.storeValues(caseId, "DRAFT_1040", values);
  await audit(caseId, "ai", "read_document", { detail: { mode: "cached", sample, fields: Object.keys(values).length, text: CACHED_READ_TEXT(Object.keys(values).length) } });
  await notify(caseId, "client", {
    es: `${PREPARER.name} subió su declaración. Ya puede revisarla.`,
    en: `${PREPARER.name} uploaded your return. You can review it now.`,
    pt: `${PREPARER.name} enviou sua declaração. Já pode revisá-la.`,
  });
  return engine.review(caseId);
}

export async function seedSeat(session: string, seat: Seat, opts: { authorize?: SeatAuthorize | null; lang?: string } = {}): Promise<SeatResult> {
  const c = await engine.createCase(session, MARIA_SEAT_INTAKE.name, opts.lang ?? "es", 25_000);
  await db.case.update({ where: { id: c.id }, data: { scenario: `seat-${seat}` } });
  await audit(c.id, "system", "judge_seat", { detail: { seat, sample: true } });
  await engine.submitIntake(c.id, MARIA_SEAT_INTAKE, { review: true, other: false });
  const kicks: AgentKick[] = [];
  const out = (target: string, reached: boolean, state: string, note?: string): SeatResult => ({
    seat,
    target,
    reached,
    state,
    note,
    case: { name: c.clientName, client: c.clientToken, preparer: c.preparerToken },
    kicks,
  });

  if (seat === "fraud") {
    const r = await replayDraft(c.id, MARIA_FRAUD_VALUES, "maria-1040-TY2025-FRAUD.pdf");
    kicks.push({ caseId: c.id, event: "review_ready" });
    return out("DIFFERENCES", r.verdict === "DIFFERENCES", r.verdict);
  }

  const r = await replayDraft(c.id, MARIA_VALUES, "maria-1040-TY2025-SAMPLE.pdf");
  if (seat === "clean") {
    kicks.push({ caseId: c.id, event: "review_ready" });
    return out("MATCH", r.verdict === "MATCH", r.verdict);
  }

  // collect / short need a real PayPal authorization before the IRS steps.
  const target = seat === "collect" ? "TRANSMITTED" : "INVESTIGATING";
  const authorize = opts.authorize === undefined ? await findSeatAuthorize() : opts.authorize;
  const fallback = (why: string) => {
    kicks.push({ caseId: c.id, event: "review_ready" });
    return out(target, false, "MATCH", `${why} The case was left ready to approve: pay with PayPal to continue.`);
  };
  if (!authorize) return fallback("Sandbox authorization for seats is not available on this server.");
  const a = await authorize(c.id).catch((e) => ({ ok: false, blocked: [String((e as Error).message ?? e).slice(0, 120)] }));
  const now = await db.case.findUniqueOrThrow({ where: { id: c.id } });
  if (!a.ok || now.state !== "AUTHORIZED") return fallback(`PayPal did not authorize the seat (${(a.blocked ?? []).join("; ") || now.state}).`);

  await engine.registerTransmission(c.id);
  if (seat === "collect") return out(target, true, "TRANSMITTED");

  const cap = await engine.ackReceived(c.id);
  const afterCap = await db.case.findUniqueOrThrow({ where: { id: c.id } });
  if (!cap.ok || afterCap.state !== "CAPTURED")
    return out(target, false, afterCap.state, `PayPal did not complete the capture (${(cap.blocked ?? []).join("; ")}).`);
  const rep = await engine.reportRefund(c.id, MARIA_DEPOSIT);
  if (!rep.matched) kicks.push({ caseId: c.id, event: "refund_reported", payload: { received: MARIA_DEPOSIT, approved: rep.approved } });
  const fin = await db.case.findUniqueOrThrow({ where: { id: c.id } });
  return out(target, fin.state === "INVESTIGATING", fin.state);
}
