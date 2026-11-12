// The ONLY module that talks to PayPal REST. Money operations are called exclusively
// from src/lib/money.ts (guardian + claim -> call -> record).

const BASE = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";

let cachedToken: { token: string; exp: number } | null = null;

/** Test hook: forget the cached OAuth token. */
export function resetPayPalToken() {
  cachedToken = null;
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

export type PPResult<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  debugId: string | null;
  body: T | null;
  endpoint: string;
};

const money = (cents: number) => ({ currency_code: "USD", value: (cents / 100).toFixed(2) });

/** Multiparty: act on behalf of the seller (unsigned JWT, as documented for PayPal-Auth-Assertion). */
export function authAssertion(merchantId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ iss: process.env.PAYPAL_CLIENT_ID ?? "", payer_id: merchantId })}.`;
}

/** MULTIPARTY=1 turns on "the preparer is the merchant". Off by default: everything goes to the platform account. */
export const multipartyEnabled = () => process.env.MULTIPARTY === "1";

function partnerHeaders(merchantId?: string | null): Record<string, string> {
  const h: Record<string, string> = {};
  if (merchantId) h["PayPal-Auth-Assertion"] = authAssertion(merchantId);
  if (process.env.PAYPAL_BN_CODE) h["PayPal-Partner-Attribution-Id"] = process.env.PAYPAL_BN_CODE;
  return h;
}

async function call<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; form?: FormData; requestId?: string; headers?: Record<string, string> } = {},
): Promise<PPResult<T>> {
  const token = await accessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Prefer: "return=representation",
    ...(opts.form ? {} : { "Content-Type": "application/json" }),
    ...(opts.headers ?? {}),
  };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: AbortSignal.timeout(20_000),
  });
  // Expired/revoked token: drop the cache so the sweeper's retry gets a fresh one.
  if (res.status === 401) cachedToken = null;
  const text = await res.text();
  let body: T | null = null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    body = null;
  }
  const debugId = res.headers.get("paypal-debug-id");
  const endpoint = `${method} ${path.split("?")[0]}`;
  if (!res.ok) console.warn(`PayPal ${endpoint} -> ${res.status} debug-id ${debugId}`);
  return { ok: res.ok, status: res.status, debugId, body, endpoint };
}

export type FeeLineInput = { kind: "FEDERAL" | "STATE"; amountCents: number; name: string };

/** The real PayPal REST client. Use `paypal` (per-case routing) or `getPaypal(caseId)` from money code. */
export const paypalRest = {
  createAuthorizeOrder(p: {
    amountCents: number;
    invoiceId: string;
    customId: string;
    description: string;
    requestId: string;
    card?: { number: string; expiry: string; name: string; cvv?: string };
    /** Line items (federal/state). Amount must equal their sum. */
    items?: FeeLineInput[];
    /** Multiparty: the preparer's merchant id (payee). Platform fees go on the capture (intent=AUTHORIZE). */
    payeeMerchantId?: string | null;
    /** Vault v3 payment token: server-side authorization with a saved PayPal wallet. */
    vaultId?: string;
  }) {
    const unit: Record<string, unknown> = {
      invoice_id: p.invoiceId,
      custom_id: p.customId,
      description: p.description,
      amount: p.items?.length
        ? { ...money(p.amountCents), breakdown: { item_total: money(p.items.reduce((a, i) => a + i.amountCents, 0)) } }
        : money(p.amountCents),
    };
    if (p.items?.length)
      unit.items = p.items.map((i) => ({ name: i.name, sku: i.kind, quantity: "1", unit_amount: money(i.amountCents), category: "DIGITAL_GOODS" }));
    if (p.payeeMerchantId) unit.payee = { merchant_id: p.payeeMerchantId };
    const body: Record<string, unknown> = { intent: "AUTHORIZE", purchase_units: [unit] };
    if (p.vaultId) body.payment_source = { paypal: { vault_id: p.vaultId } };
    else if (p.card) {
      body.payment_source = {
        card: {
          number: p.card.number,
          expiry: p.card.expiry,
          name: p.card.name,
          security_code: p.card.cvv ?? "123",
          billing_address: {
            address_line_1: "123 Main St",
            admin_area_2: "San Jose",
            admin_area_1: "CA",
            postal_code: "95131",
            country_code: "US",
          },
        },
      };
    }
    return call("POST", "/v2/checkout/orders", { body, requestId: p.requestId, headers: partnerHeaders() });
  },
  authorizeOrder(orderId: string, requestId: string) {
    return call("POST", `/v2/checkout/orders/${orderId}/authorize`, { body: {}, requestId, headers: partnerHeaders() });
  },
  getOrder(orderId: string) {
    return call("GET", `/v2/checkout/orders/${orderId}`);
  },
  /**
   * Capture an authorization. Without opts: full capture (final_capture=true), as before.
   * Partial capture: amountCents + finalCapture=false keeps the rest of the authorization open.
   * Multiparty: with intent=AUTHORIZE PayPal requires platform_fees on the capture, not on the order
   * (verified in sandbox: UNSUPPORTED_PAYMENT_INSTRUCTION on the order).
   */
  capture(
    authorizationId: string,
    requestId: string,
    opts: { amountCents?: number; finalCapture?: boolean; invoiceId?: string; platformFeeCents?: number; merchantId?: string | null } = {},
  ) {
    const body: Record<string, unknown> = { final_capture: opts.finalCapture ?? true };
    if (opts.amountCents !== undefined) body.amount = money(opts.amountCents);
    if (opts.invoiceId) body.invoice_id = opts.invoiceId;
    if (opts.platformFeeCents) body.payment_instruction = { platform_fees: [{ amount: money(opts.platformFeeCents) }] };
    return call("POST", `/v2/payments/authorizations/${authorizationId}/capture`, { body, requestId, headers: partnerHeaders(opts.merchantId) });
  },
  void(authorizationId: string, requestId: string, merchantId?: string | null) {
    return call("POST", `/v2/payments/authorizations/${authorizationId}/void`, { requestId, headers: partnerHeaders(merchantId) });
  },
  /** Refund a capture. platformFeeCents: the share of SignClear's platform fee returned with it (multiparty). */
  refund(captureId: string, requestId: string, amountCents: number, note: string, opts: { platformFeeCents?: number; merchantId?: string | null } = {}) {
    const body: Record<string, unknown> = { amount: money(amountCents), note_to_payer: note.slice(0, 255) };
    if (opts.platformFeeCents) body.payment_instruction = { platform_fees: [{ amount: money(opts.platformFeeCents) }] };
    return call("POST", `/v2/payments/captures/${captureId}/refund`, { body, requestId, headers: partnerHeaders(opts.merchantId) });
  },
  getCapture(captureId: string) {
    return call("GET", `/v2/payments/captures/${captureId}`);
  },
  /** Days 4–29 of an authorization: re-authorize to get a fresh 3-day honor period (returns a NEW authorization id). */
  reauthorize(authorizationId: string, amountCents: number, requestId: string, merchantId?: string | null) {
    return call("POST", `/v2/payments/authorizations/${authorizationId}/reauthorize`, {
      body: { amount: money(amountCents) },
      requestId,
      headers: partnerHeaders(merchantId),
    });
  },
  getAuthorization(authorizationId: string) {
    return call("GET", `/v2/payments/authorizations/${authorizationId}`);
  },

  // ---------------------------------------------------------------- Disputes v1
  listDisputes(p: { startTime?: string; pageSize?: number; nextPageToken?: string } = {}) {
    const q = new URLSearchParams({ page_size: String(p.pageSize ?? 20) });
    if (p.startTime) q.set("start_time", p.startTime);
    if (p.nextPageToken) q.set("next_page_token", p.nextPageToken);
    return call<{ items?: DisputeSummary[]; links?: Link[] }>("GET", `/v1/customer/disputes?${q}`);
  },
  getDispute(disputeId: string) {
    return call<DisputeResource>("GET", `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
  },
  /** multipart/form-data: JSON part `input` + optional PDF part `evidence-file`. */
  provideEvidence(disputeId: string, input: unknown, file?: { name: string; bytes: Uint8Array; type: string }) {
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
    if (file) form.append("evidence-file", new Blob([file.bytes as BlobPart], { type: file.type }), file.name);
    return call("POST", `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, { form });
  },
  acceptClaim(disputeId: string, note: string) {
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify({ note: note.slice(0, 2000) })], { type: "application/json" }));
    return call("POST", `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`, { form });
  },

  // ------------------------------------------------------- Transaction Search v1
  /** RFC 3339 with seconds; max range 31 days; PayPal says data can take up to 3 h to appear. */
  searchTransactions(p: { start: Date; end: Date; page?: number }) {
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    const q = new URLSearchParams({ start_date: iso(p.start), end_date: iso(p.end), fields: "transaction_info", page_size: "500", page: String(p.page ?? 1) });
    return call<{ transaction_details?: Array<{ transaction_info: TxInfo }>; last_refreshed_datetime?: string; total_pages?: number }>(
      "GET",
      `/v1/reporting/transactions?${q}`,
    );
  },

  // ------------------------------------------------------ Partner Referrals v2
  createPartnerReferral(p: { trackingId: string; returnUrl: string }) {
    return call<{ links?: Link[] }>("POST", "/v2/customer/partner-referrals", {
      body: {
        tracking_id: p.trackingId,
        operations: [
          {
            operation: "API_INTEGRATION",
            api_integration_preference: {
              rest_api_integration: {
                integration_method: "PAYPAL",
                integration_type: "THIRD_PARTY",
                third_party_details: { features: ["PAYMENT", "REFUND", "PARTNER_FEE", "DELAY_FUNDS_DISBURSEMENT", "READ_SELLER_DISPUTE", "UPDATE_SELLER_DISPUTE"] },
              },
            },
          },
        ],
        products: ["EXPRESS_CHECKOUT"],
        legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
        partner_config_override: { return_url: p.returnUrl },
      },
      requestId: `pref-${p.trackingId}`,
    });
  },
  getMerchantIntegration(partnerMerchantId: string, sellerMerchantId: string) {
    return call<{ merchant_id?: string; payments_receivable?: boolean; primary_email_confirmed?: boolean; oauth_integrations?: unknown[] }>(
      "GET",
      `/v1/customer/partners/${encodeURIComponent(partnerMerchantId)}/merchant-integrations/${encodeURIComponent(sellerMerchantId)}`,
    );
  },

  // ------------------------------------------------------------------ Vault v3
  createSetupToken(p: { returnUrl: string; cancelUrl: string; requestId: string }) {
    return call<{ id?: string; status?: string; links?: Link[] }>("POST", "/v3/vault/setup-tokens", {
      body: {
        payment_source: {
          paypal: {
            usage_type: "MERCHANT",
            experience_context: { return_url: p.returnUrl, cancel_url: p.cancelUrl, vault_instruction: "ON_PAYER_APPROVAL" },
          },
        },
      },
      requestId: p.requestId,
    });
  },
  createPaymentToken(setupTokenId: string, requestId: string) {
    return call<{ id?: string; customer?: { id?: string } }>("POST", "/v3/vault/payment-tokens", {
      body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
      requestId,
    });
  },
};

export type PayPalClient = typeof paypalRest;
type CaseMethods = "createAuthorizeOrder" | "authorizeOrder" | "getOrder" | "capture" | "getCapture" | "void" | "reauthorize" | "refund" | "getAuthorization";

// ------------------------------------------------------------- per-case client
// Nothing is ever patched at runtime. Each case-level call resolves its client from the case it belongs to:
// the Arena simulator ONLY for cases flagged `paypalSim` (set in-process by the Arena runner); the real REST
// client for everything else. Arguments are forwarded untouched in both directions.
async function simFlagFor(where: { caseId?: string; ref?: string }): Promise<boolean> {
  const { db } = await import("./db");
  if (where.caseId) return !!(await db.case.findUnique({ where: { id: where.caseId }, select: { paypalSim: true } }))?.paypalSim;
  const ref = where.ref!;
  const pay = await db.payment.findFirst({
    where: { OR: [{ orderId: ref }, { authorizationId: ref }, { captureId: ref }, { refundId: ref }] },
    select: { case: { select: { paypalSim: true } } },
  });
  if (pay) return pay.case.paypalSim;
  const line = await db.feeLine.findFirst({ where: { OR: [{ captureId: ref }, { refundId: ref }] }, select: { case: { select: { paypalSim: true } } } });
  return !!line?.case.paypalSim;
}

const refused = (endpoint: string): PPResult => ({ ok: false, status: 400, debugId: null, body: { name: "SIMULATED_ID_OUTSIDE_ARENA" }, endpoint });

/** The PayPal client for one case: the Arena simulator for Arena cases, the real REST API otherwise. */
export async function getPaypal(caseId: string): Promise<PayPalClient> {
  if (!(await simFlagFor({ caseId }))) return paypalRest;
  const { arenaPaypal } = await import("./arena/paypal-sim");
  return arenaPaypal as unknown as PayPalClient;
}

/** Resolves by PayPal id (order/authorization/capture). A simulator id is honoured only for a flagged case. */
async function clientForRef(ref: string, endpoint: string): Promise<PayPalClient | PPResult> {
  const { isSimId, arenaPaypal } = await import("./arena/paypal-sim");
  const sim = isSimId(ref);
  if (!sim) return paypalRest;
  if (await simFlagFor({ ref })) return arenaPaypal as unknown as PayPalClient;
  return refused(endpoint);
}

function byRef<K extends Exclude<CaseMethods, "createAuthorizeOrder">>(name: K) {
  return (async (...args: Parameters<PayPalClient[K]>) => {
    const cl = await clientForRef(String(args[0]), `${name} (simulated id outside the Arena)`);
    if ("ok" in cl) return cl;
    return (cl[name] as (...a: Parameters<PayPalClient[K]>) => ReturnType<PayPalClient[K]>)(...args);
  }) as unknown as PayPalClient[K];
}

/** Case-routed PayPal client (drop-in for the REST client). */
export const paypal: PayPalClient = {
  ...paypalRest,
  createAuthorizeOrder: (async (p: Parameters<PayPalClient["createAuthorizeOrder"]>[0]) => {
    if (!(await simFlagFor({ caseId: p.customId }))) return paypalRest.createAuthorizeOrder(p);
    const { arenaPaypal } = await import("./arena/paypal-sim");
    const { db } = await import("./db");
    const c = await db.case.findUnique({ where: { id: p.customId }, select: { clientName: true } });
    return arenaPaypal.createAuthorizeOrder({ ...p, payerName: c?.clientName });
  }) as PayPalClient["createAuthorizeOrder"],
  authorizeOrder: byRef("authorizeOrder"),
  getOrder: byRef("getOrder"),
  capture: byRef("capture"),
  getCapture: byRef("getCapture"),
  void: byRef("void"),
  reauthorize: byRef("reauthorize"),
  refund: byRef("refund"),
  getAuthorization: byRef("getAuthorization"),
};

export type Link = { href: string; rel: string; method?: string };
export type Money = { currency_code?: string; value?: string };
export type DisputeSummary = { dispute_id: string; reason?: string; status?: string; dispute_amount?: Money; create_time?: string; update_time?: string; links?: Link[] };
export type DisputeResource = DisputeSummary & {
  dispute_life_cycle_stage?: string;
  dispute_channel?: string;
  seller_response_due_date?: string;
  disputed_transactions?: Array<{ seller_transaction_id?: string; buyer_transaction_id?: string; invoice_number?: string; custom?: string; gross_amount?: Money }>;
  dispute_outcome?: { outcome_code?: string; amount_refunded?: Money };
};
export type TxInfo = {
  transaction_id: string;
  paypal_reference_id?: string;
  paypal_reference_id_type?: string;
  transaction_event_code?: string;
  transaction_status?: string;
  transaction_initiation_date?: string;
  transaction_amount?: Money;
  invoice_id?: string;
  custom_field?: string;
};
export const toCents = (m?: Money | null) => (m?.value ? Math.round(Number(m.value) * 100) : 0);

// Helpers to dig IDs out of PayPal order responses
type Order = {
  id?: string;
  status?: string;
  payer?: { name?: { given_name?: string; surname?: string } };
  payment_source?: { card?: { name?: string }; paypal?: { name?: { given_name?: string; surname?: string } } };
  purchase_units?: Array<{
    payee?: { merchant_id?: string };
    payments?: {
      authorizations?: Array<{ id: string; status: string; expiration_time?: string }>;
      captures?: Array<{ id: string; status: string }>;
    };
  }>;
};

export function authFromOrder(o: unknown) {
  const ord = o as Order;
  const a = ord?.purchase_units?.[0]?.payments?.authorizations?.[0];
  const payerName =
    [ord?.payer?.name?.given_name, ord?.payer?.name?.surname].filter(Boolean).join(" ") ||
    [ord?.payment_source?.paypal?.name?.given_name, ord?.payment_source?.paypal?.name?.surname].filter(Boolean).join(" ") ||
    ord?.payment_source?.card?.name ||
    null;
  return a ? { id: a.id, status: a.status, expiration: a.expiration_time, payerName } : null;
}
