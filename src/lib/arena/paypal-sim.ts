// Agent Arena only: an in-process PayPal stand-in for the simulated client's approval.
// A real authorization needs María to log in to PayPal, so for Arena cases the order/authorization/capture are
// SIMULATED while SignClear's real guardians (money.ts) decide.
//
// This module never patches anything. src/lib/paypal.ts picks it per call, and only for cases flagged
// `paypalSim` (set by the Arena runner itself, never by an API). Every method takes the SAME arguments as the
// real REST client and honours them (partial capture amount + final_capture, platform fees, merchant id), so
// a case that runs on the simulator sees the same semantics as a real one.
import crypto from "node:crypto";
import type { PPResult, FeeLineInput } from "../paypal";

export const SIM_PREFIX = "ARENA-SIM-";
const id = (k: string) => `${SIM_PREFIX}${k}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
const res = (status: number, body: Record<string, unknown> | null, endpoint: string): PPResult => ({ ok: status < 300, status, debugId: "arena-simulated", body, endpoint });
const amt = (cents: number) => ({ currency_code: "USD", value: (cents / 100).toFixed(2) });

/** Remaining amount per simulated authorization (so partial + final captures behave like PayPal's). */
const auths = new Map<string, { total: number; captured: number; closed: boolean }>();
const captures = new Map<string, { amount: number; refunded: number }>();
/** PayPal-Request-Id idempotency, as the real API does. */
const replays = new Map<string, PPResult>();
const once = (requestId: string | undefined, fn: () => PPResult) => {
  if (!requestId) return fn();
  const prev = replays.get(requestId);
  if (prev) return prev;
  const r = fn();
  replays.set(requestId, r);
  return r;
};

export const isSimId = (x: string | null | undefined) => !!x && x.startsWith(SIM_PREFIX);

export const arenaPaypal = {
  async createAuthorizeOrder(p: {
    amountCents: number;
    invoiceId: string;
    customId: string;
    description: string;
    requestId: string;
    card?: { number: string; expiry: string; name: string; cvv?: string };
    items?: FeeLineInput[];
    payeeMerchantId?: string | null;
    vaultId?: string;
    payerName?: string;
  }): Promise<PPResult> {
    if (p.items?.length && p.items.reduce((a, i) => a + i.amountCents, 0) !== p.amountCents)
      return res(422, { details: [{ issue: "ITEM_TOTAL_MISMATCH" }] }, "POST /v2/checkout/orders (Arena simulated)");
    return once(p.requestId, () => {
      const authId = id("AUTH");
      auths.set(authId, { total: p.amountCents, captured: 0, closed: false });
      const [given, ...rest] = (p.payerName ?? p.card?.name ?? "Arena Client").split(" ");
      return res(
        201,
        {
          id: id("ORD"),
          status: "COMPLETED",
          payer: { name: { given_name: given, surname: rest.join(" ") } },
          purchase_units: [
            {
              custom_id: p.customId,
              invoice_id: p.invoiceId,
              amount: amt(p.amountCents),
              ...(p.payeeMerchantId ? { payee: { merchant_id: p.payeeMerchantId } } : {}),
              payments: { authorizations: [{ id: authId, status: "CREATED", amount: amt(p.amountCents), expiration_time: new Date(Date.now() + 29 * 86400_000).toISOString() }] },
            },
          ],
        },
        "POST /v2/checkout/orders (Arena simulated)",
      );
    });
  },
  async authorizeOrder(orderId: string, requestId: string): Promise<PPResult> {
    void requestId;
    return res(422, { details: [{ issue: "ORDER_ALREADY_AUTHORIZED" }], order_id: orderId }, "authorize (sim)");
  },
  async getOrder(orderId: string): Promise<PPResult> {
    return res(200, { id: orderId, status: "COMPLETED" }, "get order (sim)");
  },
  async capture(
    authorizationId: string,
    requestId: string,
    opts: { amountCents?: number; finalCapture?: boolean; invoiceId?: string; platformFeeCents?: number; merchantId?: string | null } = {},
  ): Promise<PPResult> {
    return once(requestId, () => {
      // Unknown authorization (e.g. the server restarted mid-run): trust the requested amount, as PayPal would.
      const a = auths.get(authorizationId) ?? { total: 0, captured: 0, closed: false };
      auths.set(authorizationId, a);
      if (a.closed) return res(422, { details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }] }, "capture (sim)");
      const cents = opts.amountCents ?? Math.max(0, a.total - a.captured);
      if (a.total && a.captured + cents > a.total) return res(422, { details: [{ issue: "MAX_CAPTURE_AMOUNT_EXCEEDED" }] }, "capture (sim)");
      const final = opts.finalCapture ?? true;
      a.captured += cents;
      if (final) a.closed = true;
      const capId = id("CAP");
      captures.set(capId, { amount: cents, refunded: 0 });
      return res(
        201,
        {
          id: capId,
          status: "COMPLETED",
          ...(cents ? { amount: amt(cents) } : {}),
          final_capture: final,
          ...(opts.invoiceId ? { invoice_id: opts.invoiceId } : {}),
          ...(opts.platformFeeCents ? { seller_receivable_breakdown: { platform_fees: [{ amount: amt(opts.platformFeeCents) }] } } : {}),
          ...(opts.merchantId ? { payee: { merchant_id: opts.merchantId } } : {}),
        },
        "capture (sim)",
      );
    });
  },
  async getCapture(captureId: string): Promise<PPResult> {
    const c = captures.get(captureId);
    return res(200, { id: captureId, status: "COMPLETED", ...(c ? { amount: amt(c.amount) } : {}) }, "get capture (sim)");
  },
  async void(authorizationId: string, requestId: string, merchantId?: string | null): Promise<PPResult> {
    void merchantId;
    return once(requestId, () => {
      const a = auths.get(authorizationId);
      if (a) a.closed = true;
      return res(204, null, "void (sim)");
    });
  },
  async reauthorize(authorizationId: string, amountCents: number, requestId: string, merchantId?: string | null): Promise<PPResult> {
    void amountCents;
    void requestId;
    void merchantId;
    return res(422, { details: [{ issue: "REAUTHORIZATION_NOT_NEEDED" }], authorization_id: authorizationId }, "reauthorize (sim)");
  },
  async refund(captureId: string, requestId: string, amountCents: number, note: string, opts: { platformFeeCents?: number; merchantId?: string | null } = {}): Promise<PPResult> {
    return once(requestId, () => {
      const c = captures.get(captureId);
      if (c && c.refunded + amountCents > c.amount) return res(422, { details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] }, "refund (sim)");
      if (c) c.refunded += amountCents;
      return res(
        201,
        {
          id: id("REF"),
          status: "COMPLETED",
          amount: amt(amountCents),
          note_to_payer: note.slice(0, 255),
          ...(opts.platformFeeCents ? { platform_fees: [{ amount: amt(opts.platformFeeCents) }] } : {}),
        },
        "refund (sim)",
      );
    });
  },
  async getAuthorization(authorizationId: string): Promise<PPResult> {
    const a = auths.get(authorizationId);
    return res(200, { id: authorizationId, status: a?.closed ? (a.captured ? "CAPTURED" : "VOIDED") : a?.captured ? "PARTIALLY_CAPTURED" : "CREATED" }, "get auth (sim)");
  },
};
