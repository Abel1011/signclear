// Client-safe: turns PayPal audit rows into "what was called, on which object, with which Debug-ID".
// Object ids come from the row's own detail when it has them, else from the case's payment record.

export type PayRef = { orderId?: string | null; authorizationId?: string | null; captureId?: string | null; refundId?: string | null } | null | undefined;
export type AuditLike = { action: string; actor: string; debugId: string | null; detail: Record<string, unknown> };
export type PayPalCall = {
  /** Short human label: "Authorize", "Capture"… */
  label: string;
  /** HTTP method + path template as called on api-m.sandbox.paypal.com. */
  endpoint: string | null;
  objectKind: "order" | "authorization" | "capture" | "refund" | "dispute" | "webhook" | null;
  objectId: string | null;
  debugId: string | null;
  httpStatus: number | null;
  ppStatus: string | null;
  /** Sandbox activity link for transaction-level ids (needs the sandbox merchant login). */
  link: string | null;
};

const SANDBOX_ACTIVITY = "https://www.sandbox.paypal.com/activity/payment/";

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function paypalCall(r: AuditLike, pay: PayRef): PayPalCall | null {
  if (r.actor !== "paypal") return null;
  const d = r.detail ?? {};
  const status = typeof d.status === "number" ? d.status : null;
  const pp = str(d.pp);
  const base = { debugId: r.debugId ?? null, httpStatus: status, ppStatus: pp };
  const auth = str(d.authorizationId) ?? pay?.authorizationId ?? null;
  const order = str(d.orderId) ?? pay?.orderId ?? null;
  const cap = str(d.captureId) ?? pay?.captureId ?? null;
  const ref = str(d.refundId) ?? pay?.refundId ?? null;
  const tx = (id: string | null) => (id ? SANDBOX_ACTIVITY + id : null);
  const a = r.action;
  if (a === "create_order") return { ...base, label: "Create order (intent AUTHORIZE)", endpoint: str(d.endpoint) ?? "POST /v2/checkout/orders", objectKind: "order", objectId: order, link: null };
  if (a === "authorize") return { ...base, label: "Authorize order", endpoint: `POST /v2/checkout/orders/${order ?? "{id}"}/authorize`, objectKind: "authorization", objectId: auth, link: tx(auth) };
  if (a === "authorization_recorded") return { ...base, label: "Authorization recorded — fee held", endpoint: null, objectKind: "authorization", objectId: auth, link: tx(auth) };
  if (a === "seat_authorized") return { ...base, label: "Authorized with vaulted sandbox wallet", endpoint: null, objectKind: "order", objectId: order, link: null };
  if (a === "authorize_failed") return { ...base, label: "Authorization failed", endpoint: null, objectKind: "order", objectId: order, link: null };
  if (a === "capture") return { ...base, label: "Capture authorization", endpoint: `POST /v2/payments/authorizations/${auth ?? "{id}"}/capture`, objectKind: "capture", objectId: cap, link: tx(cap) };
  if (a === "get_capture") return { ...base, label: "Look up capture", endpoint: `GET /v2/payments/captures/${cap ?? "{id}"}`, objectKind: "capture", objectId: cap, link: tx(cap) };
  if (a === "get_authorization") return { ...base, label: "Look up authorization", endpoint: `GET /v2/payments/authorizations/${auth ?? "{id}"}`, objectKind: "authorization", objectId: auth, link: tx(auth) };
  if (a === "reauthorize" || a === "reauthorized") return { ...base, label: "Reauthorize", endpoint: `POST /v2/payments/authorizations/${str(d.from) ?? auth ?? "{id}"}/reauthorize`, objectKind: "authorization", objectId: str(d.to) ?? auth, link: tx(str(d.to) ?? auth) };
  if (/void/.test(a)) return { ...base, label: "Void authorization", endpoint: `POST /v2/payments/authorizations/${auth ?? "{id}"}/void`, objectKind: "authorization", objectId: auth, link: tx(auth) };
  if (a === "refund") return { ...base, label: "Refund capture", endpoint: `POST /v2/payments/captures/${cap ?? "{id}"}/refund`, objectKind: "refund", objectId: ref, link: tx(ref) };
  if (a === "get_order") return { ...base, label: "Look up order", endpoint: `GET /v2/checkout/orders/${order ?? "{id}"}`, objectKind: "order", objectId: order, link: null };
  if (a.startsWith("dispute") || a === "get_dispute") {
    const id = str(d.disputeId);
    return { ...base, label: a.replace(/_/g, " "), endpoint: `/v1/customer/disputes/${id ?? "{id}"}`, objectKind: "dispute", objectId: id, link: null };
  }
  if (a.startsWith("reconcile:")) return { ...base, label: `Webhook ${str(d.event) ?? ""}`.trim(), endpoint: "POST /api/paypal/webhooks (verified)", objectKind: "webhook", objectId: str(d.eventId), link: null };
  return { ...base, label: a.replace(/_/g, " "), endpoint: null, objectKind: null, objectId: null, link: null };
}

/** A cached document read (sample return / transcript) is labelled honestly instead of looking like a fresh AI call. */
export function cachedReadNote(r: AuditLike): string | null {
  const d = r.detail ?? {};
  if (r.action !== "read_document" || d.mode !== "cached") return null;
  const what = typeof d.kind === "string" ? d.kind : typeof d.sample === "string" ? `sample return ${d.sample}` : "sample return";
  return `${what}: read live by Claude on first upload; identical file replayed instantly${d.simulated ? " · SIMULATED document" : ""}`;
}
