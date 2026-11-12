import { mockPayPal, resetDb, seedCase, transmitted } from "./paypal-harness";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";
import zlib from "node:zlib";
import * as money from "../src/lib/money";
import * as disputes from "../src/lib/paypal-disputes";
import { compareLedger } from "../src/lib/paypal-ledger";
import { db } from "../src/lib/db";
import { POST as webhook } from "../src/app/api/paypal/webhooks/route";

const pp = mockPayPal();
beforeEach(async () => {
  await resetDb();
  pp.reset();
});
afterAll(() => db.$disconnect());

const state = async (id: string) => (await db.case.findUniqueOrThrow({ where: { id } })).state;
const lines = async (id: string) => Object.fromEntries((await db.feeLine.findMany({ where: { caseId: id } })).map((l) => [l.kind, l]));

// Shapes follow the examples in PayPal's webhook / Payments v2 / Disputes v1 references.
const captureEvent = (type: string, captureId: string, caseId: string, status: string) => ({
  id: `WH-${type}-${captureId}`,
  event_type: type,
  resource: {
    id: captureId,
    status,
    custom_id: caseId,
    amount: { currency_code: "USD", value: "250.00" },
    supplementary_data: { related_ids: { order_id: "ORDER1", authorization_id: "AUTH1" } },
    links: [{ href: "https://api.sandbox.paypal.com/v2/payments/authorizations/AUTH1", rel: "up", method: "GET" }],
  },
});
const refundEvent = (refundId: string, captureId: string, caseId: string) => ({
  id: `WH-REF-${refundId}`,
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: {
    id: refundId,
    status: "COMPLETED",
    custom_id: caseId,
    links: [
      { href: `https://api.sandbox.paypal.com/v2/payments/refunds/${refundId}`, rel: "self", method: "GET" },
      { href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
    ],
  },
});
const disputeFixture = (captureId: string, links: string[]) => ({
  dispute_id: "PP-D-27803",
  create_time: "2026-11-10T20:20:16.000Z",
  update_time: "2026-11-10T20:20:16.000Z",
  disputed_transactions: [{ seller_transaction_id: captureId, buyer_transaction_id: "BUYER-TX", invoice_number: "FC-x-1", gross_amount: { currency_code: "USD", value: "250.00" } }],
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "250.00" },
  dispute_life_cycle_stage: "INQUIRY",
  dispute_channel: "INTERNAL",
  seller_response_due_date: "2026-11-30T20:20:16.000Z",
  links: [{ href: "https://api.sandbox.paypal.com/v1/customer/disputes/PP-D-27803", rel: "self", method: "GET" }, ...links.map((rel) => ({ href: `https://api.sandbox.paypal.com/v1/customer/disputes/PP-D-27803/${rel.replace(/_/g, "-")}`, rel, method: "POST" }))],
});

describe("webhook reconciliation (idempotent)", () => {
  it("CAPTURE.COMPLETED completes a PENDING capture exactly once", async () => {
    const c = await seedCase({ state: "CAPTURE_PENDING", extra: transmitted, payment: { captureId: "CAP1", status: "PENDING" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "PENDING", captureId: "CAP1" }] });
    const ev = captureEvent("PAYMENT.CAPTURE.COMPLETED", "CAP1", c.id, "COMPLETED");
    expect((await money.reconcileWebhook(ev)).action).toBe("capture_completed");
    expect(await state(c.id)).toBe("CAPTURED");
    expect((await money.reconcileWebhook(ev)).action).toBe("noop");
    const notes = await db.notification.count({ where: { caseId: c.id, audience: "preparer" } });
    expect(notes).toBe(1);
    expect(pp.calls).toHaveLength(0); // reconciliation never calls money endpoints
  });

  it("CAPTURE.COMPLETED arriving before SignClear stored the capture id is attributed to the federal line", async () => {
    const c = await seedCase({ state: "CAPTURE_PENDING", extra: transmitted, payment: {}, lines: [{ kind: "FEDERAL", amount: 25_000, status: "AUTHORIZED" }] });
    await money.reconcileWebhook(captureEvent("PAYMENT.CAPTURE.COMPLETED", "CAP-EARLY", c.id, "COMPLETED"));
    expect(await state(c.id)).toBe("CAPTURED");
    expect((await lines(c.id)).FEDERAL.captureId).toBe("CAP-EARLY");
  });

  it("CAPTURE.DENIED → UNPAID and releases the rest of a partial authorization", async () => {
    const c = await seedCase({ state: "CAPTURE_PENDING", extra: transmitted, stateFee: 7_000, payment: { captureId: "CAP-D", status: "PENDING" }, lines: [{ kind: "FEDERAL", amount: 18_000, status: "PENDING", captureId: "CAP-D" }, { kind: "STATE", amount: 7_000 }] });
    pp.on("POST", /AUTH1\/void$/, { status: 204 });
    await money.reconcileWebhook(captureEvent("PAYMENT.CAPTURE.DENIED", "CAP-D", c.id, "DECLINED"));
    expect(await state(c.id)).toBe("UNPAID");
    const l = await lines(c.id);
    expect([l.FEDERAL.status, l.STATE.status]).toEqual(["DENIED", "VOIDED"]);
  });

  it("CAPTURE.PENDING records the pending line", async () => {
    const c = await seedCase({ state: "CAPTURE_PENDING", extra: transmitted, payment: {}, lines: [{ kind: "FEDERAL", amount: 25_000, status: "CAPTURE_PENDING" }] });
    await money.reconcileWebhook(captureEvent("PAYMENT.CAPTURE.PENDING", "CAP-P", c.id, "PENDING"));
    expect((await lines(c.id)).FEDERAL).toMatchObject({ status: "PENDING", captureId: "CAP-P" });
    expect(await state(c.id)).toBe("CAPTURE_PENDING");
  });

  it("CAPTURE.REFUNDED finds the capture through the 'up' link and is idempotent", async () => {
    const c = await seedCase({ state: "REFUNDED", payment: { captureId: "CAP-R", status: "REFUND_PENDING_PAYPAL" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "REFUND_PENDING", captureId: "CAP-R", refundId: "REF-R" }] });
    const ev = refundEvent("REF-R", "CAP-R", c.id);
    await money.reconcileWebhook(ev);
    await money.reconcileWebhook(ev);
    expect((await lines(c.id)).FEDERAL.status).toBe("REFUNDED");
    expect((await db.payment.findUniqueOrThrow({ where: { caseId: c.id } })).status).toBe("REFUNDED");
  });

  it("CAPTURE.REVERSED marks the line and tells the preparer", async () => {
    const c = await seedCase({ state: "CAPTURED", payment: { captureId: "CAP-V", status: "COMPLETED" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "COMPLETED", captureId: "CAP-V" }] });
    expect((await money.reconcileWebhook(captureEvent("PAYMENT.CAPTURE.REVERSED", "CAP-V", c.id, "REVERSED"))).action).toBe("capture_reversed");
    expect((await lines(c.id)).FEDERAL.status).toBe("REVERSED");
    expect((await money.reconcileWebhook(captureEvent("PAYMENT.CAPTURE.REVERSED", "CAP-V", c.id, "REVERSED"))).action).toBe("noop");
  });

  it("AUTHORIZATION.VOIDED completes a stuck VOID_PENDING; an old authorization id is ignored", async () => {
    const c = await seedCase({ state: "VOID_PENDING", payment: {}, lines: [{ kind: "FEDERAL", amount: 25_000 }] });
    expect((await money.reconcileWebhook({ id: "WH-V0", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: "AUTH-OLD", custom_id: c.id, status: "VOIDED" } })).action).toMatch(/noop/);
    await money.reconcileWebhook({ id: "WH-V1", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: "AUTH1", custom_id: c.id, status: "VOIDED" } });
    expect(await state(c.id)).toBe("VOIDED");
  });

  it("AUTHORIZATION.CREATED records an authorization the browser never reported (reads the order)", async () => {
    const c = await seedCase({ state: "MATCH", payment: { orderId: "O-W", authorizationId: null, status: "CREATED" } });
    pp.on("GET", /orders\/O-W$/, { status: 200, body: { id: "O-W", status: "COMPLETED", payer: { name: { given_name: "María", surname: "González" } }, purchase_units: [{ payments: { authorizations: [{ id: "A-W", status: "CREATED" }] } }] } });
    await money.reconcileWebhook({ id: "WH-A", event_type: "PAYMENT.AUTHORIZATION.CREATED", resource: { id: "A-W", custom_id: c.id, status: "CREATED", supplementary_data: { related_ids: { order_id: "O-W" } } } });
    expect(await state(c.id)).toBe("AUTHORIZED");
    expect((await db.payment.findUniqueOrThrow({ where: { caseId: c.id } })).authorizationId).toBe("A-W");
  });
});

describe("disputes", () => {
  it("CUSTOMER.DISPUTE.CREATED links to the case by capture id; only HATEOAS-allowed actions are offered", async () => {
    const c = await seedCase({ state: "CAPTURED", extra: transmitted, payment: { captureId: "CAP-F", status: "COMPLETED" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "COMPLETED", captureId: "CAP-F" }] });
    pp.on("GET", /disputes\/PP-D-27803$/, { status: 200, body: disputeFixture("CAP-F", ["provide_evidence"]) });
    const r = await money.reconcileWebhook({ id: "WH-D1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: disputeFixture("CAP-F", []) as never });
    expect(r).toEqual({ caseId: c.id, action: "dispute:WAITING_FOR_SELLER_RESPONSE" });
    const v = await disputes.disputesView(c.id);
    expect(v[0]).toMatchObject({ disputeId: "PP-D-27803", amount: 25_000, actions: ["provide_evidence"] });
    expect((await disputes.acceptClaim(c.id, "PP-D-27803", "")).ok).toBe(false); // no accept_claim link
    expect(pp.find("POST", /accept-claim/)).toHaveLength(0);
  });

  it("evidence package: approved snapshot, 7216 consent, IRS acceptance + Submission ID → multipart provide-evidence", async () => {
    const c = await seedCase({ state: "CAPTURED", extra: transmitted, payment: { captureId: "CAP-E", status: "COMPLETED" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "COMPLETED", captureId: "CAP-E" }] });
    await db.approvedSnapshot.create({ data: { caseId: c.id, data: JSON.stringify({ refund: 412_300 }) } });
    await db.auditEvent.create({ data: { caseId: c.id, actor: "user", action: "consent_and_intake", detail: JSON.stringify({ review: true, other: false }) } });
    await disputes.syncDispute(disputeFixture("CAP-E", ["provide_evidence", "accept_claim"]) as never);
    const pkg = await disputes.buildEvidence(c.id);
    expect(pkg.irs.submissionId).toBe(transmitted.submissionId);
    expect(pkg.consent7216).not.toBeNull();
    expect(pkg.approved.refund).toBe(412_300);
    expect(disputes.evidenceNotes(pkg)).toMatch(/IRS accepted.*Submission ID 12345620261234abc1234/);
    pp.on("POST", /provide-evidence$/, { status: 200, body: { links: [] } });
    pp.on("GET", /disputes\/PP-D-27803$/, { status: 200, body: { ...disputeFixture("CAP-E", []), status: "UNDER_REVIEW" } });
    const r = await disputes.provideEvidence(c.id, "PP-D-27803");
    expect(r.ok).toBe(true);
    const call = pp.find("POST", /provide-evidence$/)[0];
    const input = JSON.parse(await (call.form!.get("input") as Blob).text());
    expect(input.evidences[0].evidence_type).toBe("PROOF_OF_FULFILLMENT");
    const pdf = call.form!.get("evidence-file") as Blob;
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const v = await disputes.disputesView(c.id);
    expect(v[0].status).toBe("UNDER_REVIEW");
    expect(v[0].actions).toEqual([]);
  });

  it("polling fallback: list → get each new dispute", async () => {
    const c = await seedCase({ state: "CAPTURED", payment: { captureId: "CAP-Q", status: "COMPLETED" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "COMPLETED", captureId: "CAP-Q" }] });
    pp.on("GET", /\/v1\/customer\/disputes$/, { status: 200, body: { items: [{ dispute_id: "PP-D-27803", status: "WAITING_FOR_SELLER_RESPONSE" }] } });
    pp.on("GET", /disputes\/PP-D-27803$/, { status: 200, body: disputeFixture("CAP-Q", ["accept_claim"]) });
    const r = await disputes.pollDisputes();
    expect(r).toMatchObject({ ok: true, synced: 1, total: 1 });
    expect((await db.dispute.findFirstOrThrow()).caseId).toBe(c.id);
  });

  it("rel names with hyphens are normalized", () => {
    expect(disputes.allowedActions([{ rel: "provide-evidence", href: "" }, { rel: "make_offer", href: "" }])).toEqual(["provide_evidence"]);
  });
});

describe("ledger reconciliation", () => {
  const local = [
    { caseId: "c1", client: "A", kind: "CAPTURE" as const, line: "FEDERAL", paypalId: "CAP1", cents: 18_000, status: "COMPLETED", at: new Date(Date.now() - 10 * 3600_000) },
    { caseId: "c1", client: "A", kind: "CAPTURE" as const, line: "STATE", paypalId: "CAP2", cents: 7_000, status: "COMPLETED", at: new Date(Date.now() - 60_000) },
    { caseId: "c1", client: "A", kind: "REFUND" as const, line: "FEDERAL", paypalId: "REF1", cents: 18_000, status: "COMPLETED", at: new Date(Date.now() - 10 * 3600_000) },
    { caseId: "c1", client: "A", kind: "CAPTURE" as const, line: "FEDERAL", paypalId: "CAP9", cents: 5_000, status: "COMPLETED", at: new Date(Date.now() - 10 * 3600_000) },
  ];
  it("flags amount mismatches, lag, missing and unknown movements", () => {
    const rows = compareLedger(local, [
      { transaction_id: "CAP1", transaction_status: "S", transaction_amount: { value: "180.00" }, transaction_event_code: "T0006" },
      { transaction_id: "REF1", transaction_status: "S", transaction_amount: { value: "-170.00" }, transaction_event_code: "T1107" },
      { transaction_id: "CAPX", transaction_status: "S", transaction_amount: { value: "250.00" }, invoice_id: "FC-zzz-1", custom_field: "zzz" },
      { transaction_id: "OTHER", transaction_status: "S", transaction_amount: { value: "9.00" } },
    ]);
    const v = Object.fromEntries(rows.map((r) => [r.paypalId, r.verdict]));
    expect(v).toEqual({ CAP1: "MATCH", CAP2: "AWAITING_PAYPAL_SYNC", REF1: "AMOUNT_MISMATCH", CAP9: "MISSING_AT_PAYPAL", CAPX: "UNKNOWN_TO_SIGNCLEAR" });
  });
  it("without PayPal data everything is NOT_CHECKED (Transaction Search not enabled)", () => {
    expect(compareLedger(local, null).every((r) => r.verdict === "NOT_CHECKED")).toBe(true);
  });
});

describe("webhook route", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signed = (raw: string, webhookId: string) => {
    const tid = `t-${Math.random()}`;
    const time = new Date().toISOString();
    const crc = (zlib as unknown as { crc32: (b: Buffer) => number }).crc32(Buffer.from(raw, "utf8"));
    const sig = crypto.createSign("sha256").update(`${tid}|${time}|${webhookId}|${crc}`).sign(privateKey, "base64");
    return new Request("http://localhost/api/paypal/webhooks", {
      method: "POST",
      body: raw,
      headers: { "paypal-transmission-id": tid, "paypal-transmission-time": time, "paypal-transmission-sig": sig, "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1" },
    });
  };

  it("fails closed without PAYPAL_WEBHOOK_ID", async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    const res = await webhook(new Request("http://localhost/x", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });

  it("verifies, reconciles, dedupes by event id; rejects a bad signature", async () => {
    process.env.PAYPAL_WEBHOOK_ID = "WH-ID";
    const c = await seedCase({ state: "CAPTURE_PENDING", extra: transmitted, payment: { captureId: "CAP-W", status: "PENDING" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "PENDING", captureId: "CAP-W" }] });
    pp.always("GET", /notifications\/certs\/CERT-1$/, { status: 200, body: undefined });
    // the cert endpoint returns PEM text, not JSON: patch the reply
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL, i?: RequestInit) => (String(u).includes("/certs/") ? new Response(pem) : origFetch(u, i))) as typeof fetch;
    const raw = JSON.stringify(captureEvent("PAYMENT.CAPTURE.COMPLETED", "CAP-W", c.id, "COMPLETED"));
    const r1 = await webhook(signed(raw, "WH-ID"));
    expect(await r1.json()).toMatchObject({ ok: true, reconciled: "capture_completed" });
    expect(await state(c.id)).toBe("CAPTURED");
    expect(await (await webhook(signed(raw, "WH-ID"))).json()).toEqual({ duplicate: true });
    expect((await webhook(signed(raw, "OTHER-ID"))).status).toBe(400);
    globalThis.fetch = origFetch;
    delete process.env.PAYPAL_WEBHOOK_ID;
  });
});
