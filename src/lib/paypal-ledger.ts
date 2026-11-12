// SignClear ledger vs. PayPal Transaction Search (GET /v1/reporting/transactions).
import { db } from "./db";
import { paypal, toCents, type TxInfo } from "./paypal";

export type LedgerRow = {
  key: string;
  client: string;
  kind: "CAPTURE" | "REFUND" | "PAYPAL_ONLY";
  line: string;
  paypalId: string;
  signclearCents: number | null;
  paypalCents: number | null;
  signclearStatus: string;
  paypalStatus: string | null; // S | P | D | V (Transaction Search codes)
  eventCode: string | null;
  at: string | null;
  verdict: "MATCH" | "AMOUNT_MISMATCH" | "STATUS_MISMATCH" | "AWAITING_PAYPAL_SYNC" | "MISSING_AT_PAYPAL" | "UNKNOWN_TO_SIGNCLEAR" | "NOT_CHECKED";
};

export type LedgerResult = {
  rows: LedgerRow[];
  paypal: { available: boolean; status: number; debugId: string | null; reason?: string; lastRefreshed?: string | null; count: number };
  lagHours: number;
  range: { start: string; end: string };
};

/** PayPal: "up to three hours" for transactions to appear; sandbox often lags more. */
export const lagHours = () => Math.max(0, Number(process.env.LEDGER_LAG_HOURS ?? 3) || 3);

const expectStatus: Record<string, string[]> = {
  COMPLETED: ["S"],
  PENDING: ["P"],
  REFUND_PENDING: ["S", "P"],
  REFUNDED: ["S", "V"], // original capture shows V once fully refunded/reversed
  REVERSED: ["V"],
  DENIED: ["D"],
};

export function compareLedger(
  local: Array<{ client: string; kind: "CAPTURE" | "REFUND"; line: string; paypalId: string; cents: number; status: string; at: Date | null; caseId: string }>,
  remote: TxInfo[] | null,
  nowMs = Date.now(),
  lag = lagHours(),
): LedgerRow[] {
  const byId = new Map((remote ?? []).map((t) => [t.transaction_id, t]));
  const rows: LedgerRow[] = local.map((l) => {
    const t = byId.get(l.paypalId);
    byId.delete(l.paypalId);
    const base = { key: `${l.kind}-${l.paypalId}`, client: l.client, kind: l.kind, line: l.line, paypalId: l.paypalId, signclearCents: l.cents, signclearStatus: l.status, at: l.at?.toISOString() ?? null };
    if (!remote) return { ...base, paypalCents: null, paypalStatus: null, eventCode: null, verdict: "NOT_CHECKED" as const };
    if (!t) {
      const recent = !l.at || nowMs - l.at.getTime() < lag * 3600_000;
      return { ...base, paypalCents: null, paypalStatus: null, eventCode: null, verdict: recent ? ("AWAITING_PAYPAL_SYNC" as const) : ("MISSING_AT_PAYPAL" as const) };
    }
    const cents = Math.abs(toCents(t.transaction_amount));
    const st = t.transaction_status ?? null;
    const verdict = cents !== l.cents ? "AMOUNT_MISMATCH" : st && expectStatus[l.status] && !expectStatus[l.status].includes(st) ? "STATUS_MISMATCH" : "MATCH";
    return { ...base, paypalCents: cents, paypalStatus: st, eventCode: t.transaction_event_code ?? null, verdict: verdict as LedgerRow["verdict"] };
  });
  // PayPal movements on SignClear invoices that SignClear doesn't know about.
  const caseIds = new Set(local.map((l) => l.caseId));
  for (const t of byId.values()) {
    const ours = (t.custom_field && caseIds.has(t.custom_field)) || /^FC-/.test(t.invoice_id ?? "");
    if (!ours) continue;
    rows.push({
      key: `PP-${t.transaction_id}`,
      client: t.custom_field ?? t.invoice_id ?? "?",
      kind: "PAYPAL_ONLY",
      line: "-",
      paypalId: t.transaction_id,
      signclearCents: null,
      paypalCents: Math.abs(toCents(t.transaction_amount)),
      signclearStatus: "-",
      paypalStatus: t.transaction_status ?? null,
      eventCode: t.transaction_event_code ?? null,
      at: t.transaction_initiation_date ?? null,
      verdict: "UNKNOWN_TO_SIGNCLEAR",
    });
  }
  return rows;
}

export async function localLedger(caseIds: string[]) {
  const cases = await db.case.findMany({ where: { id: { in: caseIds } }, include: { feeLines: true, payment: true } });
  const out: Parameters<typeof compareLedger>[0] = [];
  for (const c of cases) {
    const lines = c.feeLines.length
      ? c.feeLines
      : c.payment?.captureId
        ? [{ kind: "FEDERAL", captureId: c.payment.captureId, amount: c.fee, status: c.payment.status, capturedAt: c.capturedAt, refundId: c.payment.refundId, refundedAmount: c.payment.refundId ? c.fee : 0, updatedAt: c.payment.updatedAt }]
        : [];
    for (const l of lines) {
      if (l.captureId) out.push({ caseId: c.id, client: c.clientName, kind: "CAPTURE", line: l.kind, paypalId: l.captureId, cents: l.amount, status: l.status, at: l.capturedAt });
      if (l.refundId) out.push({ caseId: c.id, client: c.clientName, kind: "REFUND", line: l.kind, paypalId: l.refundId, cents: l.refundedAmount || l.amount, status: "COMPLETED", at: l.updatedAt });
    }
  }
  return out;
}

export async function reconcileLedger(caseIds: string[], days = 30): Promise<LedgerResult> {
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(31, Math.max(1, days)) * 86400_000);
  const local = await localLedger(caseIds);
  const res = await paypal.searchTransactions({ start, end });
  // Follow every page (Transaction Search returns at most 500 rows per page).
  if (res.ok && res.body?.transaction_details && (res.body.total_pages ?? 1) > 1) {
    for (let page = 2; page <= Math.min(res.body.total_pages ?? 1, 20); page++) {
      const more = await paypal.searchTransactions({ start, end, page });
      if (!more.ok) break;
      res.body.transaction_details.push(...(more.body?.transaction_details ?? []));
    }
  }
  const range = { start: start.toISOString(), end: end.toISOString() };
  if (!res.ok) {
    const name = (res.body as { name?: string } | null)?.name;
    return {
      rows: compareLedger(local, null),
      paypal: {
        available: false,
        status: res.status,
        debugId: res.debugId,
        reason: res.status === 403 ? `${name ?? "NOT_AUTHORIZED"}: enable "Transaction search" for this app in the PayPal developer dashboard` : `${name ?? "error"} (HTTP ${res.status})`,
        count: 0,
      },
      lagHours: lagHours(),
      range,
    };
  }
  const remote = (res.body?.transaction_details ?? []).map((d) => d.transaction_info);
  return {
    rows: compareLedger(local, remote),
    paypal: { available: true, status: res.status, debugId: res.debugId, lastRefreshed: res.body?.last_refreshed_datetime ?? null, count: remote.length },
    lagHours: lagHours(),
    range,
  };
}
