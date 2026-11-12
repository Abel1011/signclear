import { mockPayPal, ppErr, resetDb, seedCase, transmitted } from "./paypal-harness";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as money from "../src/lib/money";
import { db } from "../src/lib/db";

const pp = mockPayPal();
beforeEach(async () => {
  await resetDb();
  pp.reset();
  delete process.env.MULTIPARTY;
});
afterAll(() => db.$disconnect());

const state = async (id: string) => (await db.case.findUniqueOrThrow({ where: { id } })).state;
const lines = async (id: string) => Object.fromEntries((await db.feeLine.findMany({ where: { caseId: id } })).map((l) => [l.kind, l]));
const fedLine = { kind: "FEDERAL", amount: 25_000, status: "AUTHORIZED" };

describe("create order + authorize", () => {
  it("single fee: no items, no payee (backwards compatible)", async () => {
    const c = await seedCase({ state: "MATCH" });
    pp.on("POST", /\/v2\/checkout\/orders$/, { status: 201, body: { id: "O-1", status: "CREATED" } });
    const r = await money.createOrder(c.id);
    expect(r.ok).toBe(true);
    const body = pp.calls[0].body as { purchase_units: Array<Record<string, unknown>> };
    expect(body.purchase_units[0].items).toBeUndefined();
    expect(body.purchase_units[0].payee).toBeUndefined();
    expect((body.purchase_units[0].amount as { value: string }).value).toBe("250.00");
  });

  it("federal + state split becomes line items with an item_total breakdown", async () => {
    const c = await seedCase({ state: "MATCH", stateFee: 7_000 });
    pp.on("POST", /\/v2\/checkout\/orders$/, { status: 201, body: { id: "O-2", status: "CREATED" } });
    await money.createOrder(c.id);
    const u = (pp.calls[0].body as { purchase_units: Array<{ items: Array<{ sku: string; unit_amount: { value: string } }>; amount: { breakdown: { item_total: { value: string } } } }> }).purchase_units[0];
    expect(u.items.map((i) => [i.sku, i.unit_amount.value])).toEqual([["FEDERAL", "180.00"], ["STATE", "70.00"]]);
    expect(u.amount.breakdown.item_total.value).toBe("250.00");
  });

  it("authorization creates one fee line per component", async () => {
    const c = await seedCase({ state: "MATCH", stateFee: 7_000, payment: { orderId: "O-3", authorizationId: null, status: "CREATED" } });
    pp.on("POST", /\/orders\/O-3\/authorize$/, { status: 201, body: { id: "O-3", purchase_units: [{ payments: { authorizations: [{ id: "A-3", status: "CREATED" }] } }] } });
    expect((await money.authorizeOrder(c.id, "O-3")).ok).toBe(true);
    const l = await lines(c.id);
    expect([l.FEDERAL.amount, l.STATE.amount, l.STATE.status]).toEqual([18_000, 7_000, "AUTHORIZED"]);
    expect(await state(c.id)).toBe("AUTHORIZED");
  });

  it("multiparty: payee.merchant_id only with MULTIPARTY=1 and an onboarded preparer", async () => {
    process.env.MULTIPARTY = "1";
    const c = await seedCase({ state: "MATCH", merchantId: "SELLER123" });
    pp.on("POST", /\/v2\/checkout\/orders$/, { status: 201, body: { id: "O-4", status: "CREATED" } });
    await money.createOrder(c.id);
    expect((pp.calls[0].body as { purchase_units: Array<{ payee: unknown }> }).purchase_units[0].payee).toEqual({ merchant_id: "SELLER123" });
    expect((await db.payment.findUniqueOrThrow({ where: { caseId: c.id } })).payeeMerchantId).toBe("SELLER123");
  });

  it("seat authorize needs PAYPAL_SEAT_VAULT_ID and uses payment_source.paypal.vault_id", async () => {
    delete process.env.PAYPAL_SEAT_VAULT_ID;
    const c = await seedCase({ state: "MATCH" });
    expect((await money.seatAuthorize(c.id)).blocked?.[0]).toMatch(/PAYPAL_SEAT_VAULT_ID/);
    process.env.PAYPAL_SEAT_VAULT_ID = "VAULT-1";
    pp.on("POST", /\/v2\/checkout\/orders$/, { status: 201, body: { id: "O-5", status: "COMPLETED", payment_source: { paypal: { name: { given_name: "María", surname: "González" } } }, purchase_units: [{ payments: { authorizations: [{ id: "A-5", status: "CREATED" }] } }] } });
    const r = await money.seatAuthorize(c.id);
    expect(r.ok).toBe(true);
    expect((pp.calls[0].body as { payment_source: unknown }).payment_source).toEqual({ paypal: { vault_id: "VAULT-1" } });
    expect(await state(c.id)).toBe("AUTHORIZED");
    expect((await db.case.findUniqueOrThrow({ where: { id: c.id } })).r15Flag).toBe(false);
    delete process.env.PAYPAL_SEAT_VAULT_ID;
  });
});

describe("capture (R13)", () => {
  it("COMPLETED: single fee captures with final_capture=true and no amount", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /authorizations\/AUTH1\/capture$/, { status: 201, body: { id: "CAP1", status: "COMPLETED" } });
    expect((await money.capture(c.id, "system")).ok).toBe(true);
    expect(pp.calls[0].body).toEqual({ final_capture: true });
    expect(pp.calls[0].headers["PayPal-Request-Id"]).toBe("cap-AUTH1");
    expect(await state(c.id)).toBe("CAPTURED");
    expect((await lines(c.id)).FEDERAL).toMatchObject({ status: "COMPLETED", captureId: "CAP1" });
  });

  it("blocked without IRS acceptance — no PayPal call", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: { ...transmitted, ackReceivedAt: null }, payment: {} });
    const r = await money.capture(c.id, "ai");
    expect(r.blocked?.join(" ")).toMatch(/R13/);
    expect(pp.calls).toHaveLength(0);
  });

  it("PENDING stays CAPTURE_PENDING, then a lookup completes it", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/capture$/, { status: 201, body: { id: "CAP2", status: "PENDING" } });
    expect((await money.capture(c.id, "system")).ok).toBe(false);
    expect(await state(c.id)).toBe("CAPTURE_PENDING");
    expect((await lines(c.id)).FEDERAL.status).toBe("PENDING");
    pp.on("GET", /captures\/CAP2$/, { status: 200, body: { id: "CAP2", status: "COMPLETED" } });
    expect((await money.finishCapture(c.id)).ok).toBe(true);
    expect(await state(c.id)).toBe("CAPTURED");
  });

  it("DENIED capture → UNPAID", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/capture$/, { status: 201, body: { id: "CAP3", status: "DECLINED" } });
    await money.capture(c.id, "system");
    expect(await state(c.id)).toBe("UNPAID");
  });

  it.each([500, 503, 401, 429])("transient %i: stays CAPTURE_PENDING; retry with the same PayPal-Request-Id succeeds", async (code) => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/capture$/, ppErr(code), { status: 201, body: { id: `CAP-${code}`, status: "COMPLETED" } });
    const r1 = await money.capture(c.id, "system");
    expect(r1.blocked?.[0]).toMatch(/retry later/);
    expect(await state(c.id)).toBe("CAPTURE_PENDING");
    expect((await money.finishCapture(c.id)).ok).toBe(true);
    const caps = pp.find("POST", /AUTH1\/capture$/);
    expect(caps.map((x) => x.headers["PayPal-Request-Id"])).toEqual(["cap-AUTH1", "cap-AUTH1"]);
    expect(await state(c.id)).toBe("CAPTURED");
  });

  it("INSTRUMENT_DECLINED on a still-valid authorization → one reauthorization, capture on the new id", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/capture$/, ppErr(422, "INSTRUMENT_DECLINED"));
    pp.on("GET", /authorizations\/AUTH1$/, { status: 200, body: { id: "AUTH1", status: "CREATED" } });
    pp.on("POST", /AUTH1\/reauthorize$/, { status: 201, body: { id: "AUTH2", status: "CREATED" } });
    pp.on("POST", /AUTH2\/capture$/, { status: 201, body: { id: "CAP4", status: "COMPLETED" } });
    expect((await money.capture(c.id, "system")).ok).toBe(true);
    expect((await db.payment.findUniqueOrThrow({ where: { caseId: c.id } })).authorizationId).toBe("AUTH2");
  });

  it("AUTHORIZATION_EXPIRED can't be re-authorized → UNPAID, nothing voided", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/capture$/, ppErr(422, "AUTHORIZATION_EXPIRED"));
    pp.on("GET", /authorizations\/AUTH1$/, { status: 200, body: { id: "AUTH1", status: "EXPIRED" } });
    await money.capture(c.id, "system");
    expect(await state(c.id)).toBe("UNPAID");
  });

  it("a 4xx while PayPal already captured → reconcile, never void", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/capture$/, ppErr(422, "SOMETHING_ODD"));
    pp.on("GET", /authorizations\/AUTH1$/, { status: 200, body: { id: "AUTH1", status: "CAPTURED" } });
    const r = await money.capture(c.id, "system");
    expect(r.ok).toBe(false);
    expect(await state(c.id)).toBe("CAPTURE_PENDING");
  });

  it("terminal error → UNPAID and the hold is voided", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/capture$/, ppErr(422, "PAYER_CANNOT_PAY"));
    pp.on("GET", /authorizations\/AUTH1$/, { status: 200, body: { id: "AUTH1", status: "CREATED" } });
    pp.on("POST", /AUTH1\/void$/, { status: 204 });
    await money.capture(c.id, "system");
    expect(await state(c.id)).toBe("UNPAID");
    expect((await lines(c.id)).FEDERAL.status).toBe("VOIDED");
  });
});

describe("re-authorize race", () => {
  it("if the fee was captured meanwhile, the new authorization is voided, not swapped in", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {} });
    // The capture lands while the reauthorize call is in flight.
    pp.on("POST", /AUTH1\/reauthorize$/, () => {
      raced = db.payment.update({ where: { caseId: c.id }, data: { captureId: "CAP-RACE" } });
      return { status: 201, body: { id: "AUTH-NEW", status: "CREATED" } };
    });
    pp.on("POST", /AUTH-NEW\/void$/, { status: 204 });
    let raced: Promise<unknown> | null = null;
    const orig = db.payment.updateMany.bind(db.payment);
    const spy = vi.spyOn(db.payment, "updateMany").mockImplementation((async (a: Parameters<typeof orig>[0]) => {
      await raced;
      return orig(a);
    }) as never);
    expect(await money.reauthorize(c.id)).toBe(false);
    expect(pp.find("POST", /AUTH-NEW\/void$/)).toHaveLength(1);
    expect((await db.payment.findUniqueOrThrow({ where: { caseId: c.id } })).authorizationId).toBe("AUTH1");
    spy.mockRestore();
  });
  it("only one re-authorization per case", async () => {
    const c = await seedCase({ state: "AUTHORIZED", payment: {} });
    pp.on("POST", /AUTH1\/reauthorize$/, { status: 201, body: { id: "AUTH9", status: "CREATED" } });
    expect(await money.reauthorize(c.id)).toBe(true);
    expect(await money.reauthorize(c.id)).toBe(false);
    expect(pp.find("POST", /reauthorize$/)).toHaveLength(1);
  });
});

describe("void", () => {
  it("transient 503 keeps VOID_PENDING; retry voids", async () => {
    const c = await seedCase({ state: "AUTHORIZED", payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/void$/, ppErr(503), { status: 204 });
    expect((await money.voidAuth(c.id, "deadline")).ok).toBe(false);
    expect(await state(c.id)).toBe("VOID_PENDING");
    expect((await money.finishVoid(c.id)).ok).toBe(true);
    expect(await state(c.id)).toBe("VOIDED");
    expect((await lines(c.id)).FEDERAL.status).toBe("VOIDED");
  });
  it("terminal 422 → VOID_FAILED", async () => {
    const c = await seedCase({ state: "AUTHORIZED", payment: {} });
    pp.on("POST", /AUTH1\/void$/, ppErr(422, "AUTHORIZATION_ALREADY_CAPTURED"));
    await money.voidAuth(c.id, "deadline");
    expect(await state(c.id)).toBe("VOID_FAILED");
  });
  it("client cannot cancel after transmission", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {} });
    expect((await money.voidAuth(c.id, "client_cancel")).blocked?.join(" ")).toMatch(/after transmission/);
  });
});

describe("partial capture: federal at IRS acceptance, state at state acceptance", () => {
  const split = { stateFee: 7_000, lines: [{ kind: "FEDERAL", amount: 18_000 }, { kind: "STATE", amount: 7_000 }] };

  it("federal capture is partial (final_capture=false); state capture closes the authorization", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: { attempt: 1 }, ...split });
    pp.on("POST", /AUTH1\/capture$/, { status: 201, body: { id: "CAP-F", status: "COMPLETED" } }, { status: 201, body: { id: "CAP-S", status: "COMPLETED" } });
    expect((await money.capture(c.id, "system")).ok).toBe(true);
    expect(pp.calls[0].body).toMatchObject({ final_capture: false, amount: { value: "180.00" }, invoice_id: `FC-${c.id}-1-FED` });
    expect(await state(c.id)).toBe("CAPTURED");
    expect((await lines(c.id)).STATE.status).toBe("AUTHORIZED");

    const r = await money.stateAckReceived(c.id);
    expect(r.ok).toBe(true);
    expect(pp.calls[1].body).toMatchObject({ final_capture: true, amount: { value: "70.00" } });
    expect(pp.calls[1].headers["PayPal-Request-Id"]).toBe("cap-AUTH1-STATE");
    const l = await lines(c.id);
    expect([l.FEDERAL.captureId, l.STATE.captureId, l.STATE.status]).toEqual(["CAP-F", "CAP-S", "COMPLETED"]);
    // idempotent
    expect((await money.stateAckReceived(c.id)).already).toBe(true);
    expect(pp.calls).toHaveLength(2);
  });

  it("state line cannot be captured before the federal one (R13 per line)", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, ...split });
    expect((await money.stateAckReceived(c.id)).ok).toBe(false);
    expect(pp.calls).toHaveLength(0);
  });

  it("state Submission ID must come from the preparer's EFIN", async () => {
    const c = await seedCase({ state: "CAPTURED", extra: transmitted, payment: { captureId: "CAP-F" }, stateFee: 7_000, lines: [{ kind: "FEDERAL", amount: 18_000, status: "COMPLETED", captureId: "CAP-F" }, { kind: "STATE", amount: 7_000 }] });
    const r = await money.stateAckReceived(c.id, "99999920261234abc1234");
    expect(r.blocked?.join(" ")).toMatch(/EFIN/);
    expect(pp.calls).toHaveLength(0);
  });

  it("state not accepted by the deadline → the remainder is voided by the sweeper", async () => {
    const c = await seedCase({
      state: "CAPTURED",
      extra: { ...transmitted, ackDeadline: new Date(Date.now() - 1000) },
      payment: { captureId: "CAP-F" },
      stateFee: 7_000,
      lines: [{ kind: "FEDERAL", amount: 18_000, status: "COMPLETED", captureId: "CAP-F" }, { kind: "STATE", amount: 7_000 }],
    });
    pp.on("POST", /AUTH1\/void$/, { status: 204 });
    await money.sweepLines(c.id);
    expect(pp.find("POST", /AUTH1\/void$/)[0].headers["PayPal-Request-Id"]).toBe("void-AUTH1-remainder");
    expect((await lines(c.id)).STATE.status).toBe("VOIDED");
  });

  it("transient error on the state capture keeps CAPTURE_PENDING for the sweeper", async () => {
    const c = await seedCase({ state: "CAPTURED", extra: transmitted, payment: { captureId: "CAP-F" }, stateFee: 7_000, lines: [{ kind: "FEDERAL", amount: 18_000, status: "COMPLETED", captureId: "CAP-F" }, { kind: "STATE", amount: 7_000 }] });
    pp.on("POST", /AUTH1\/capture$/, ppErr(500), { status: 201, body: { id: "CAP-S2", status: "COMPLETED" } });
    expect((await money.stateAckReceived(c.id)).blocked?.[0]).toMatch(/retry/);
    expect((await lines(c.id)).STATE.status).toBe("CAPTURE_PENDING");
    await money.sweepLines(c.id, { force: true });
    expect((await lines(c.id)).STATE.status).toBe("COMPLETED");
  });
});

describe("refund", () => {
  const proposed = { refundDeadline: new Date(Date.now() - 1000), clientConfirmedRefund: true, capturedAt: new Date(), ...transmitted };

  it("legacy single capture: one refund of the whole fee", async () => {
    const c = await seedCase({ state: "REFUND_PROPOSED", extra: proposed, payment: { captureId: "CAP-L", status: "COMPLETED" } });
    pp.on("POST", /captures\/CAP-L\/refund$/, { status: 201, body: { id: "REF-L", status: "COMPLETED" } });
    expect((await money.refund(c.id, "system")).ok).toBe(true);
    expect(pp.calls[0].headers["PayPal-Request-Id"]).toBe(`ref-${c.id}`);
    expect(await state(c.id)).toBe("REFUNDED");
  });

  it("two captures: refunds both; a transient error resumes only the missing one", async () => {
    const c = await seedCase({
      state: "REFUND_PROPOSED",
      extra: proposed,
      stateFee: 7_000,
      payment: { captureId: "CAP-F", status: "COMPLETED" },
      lines: [{ kind: "FEDERAL", amount: 18_000, status: "COMPLETED", captureId: "CAP-F" }, { kind: "STATE", amount: 7_000, status: "COMPLETED", captureId: "CAP-S" }],
    });
    pp.on("POST", /CAP-F\/refund$/, { status: 201, body: { id: "REF-F", status: "COMPLETED" } });
    pp.on("POST", /CAP-S\/refund$/, ppErr(500), { status: 201, body: { id: "REF-S", status: "COMPLETED" } });
    expect((await money.refund(c.id, "system")).blocked?.[0]).toMatch(/retry/);
    expect(await state(c.id)).toBe("REFUND_PENDING");
    expect((await money.finishRefund(c.id)).ok).toBe(true);
    expect(pp.find("POST", /CAP-F\/refund$/)).toHaveLength(1);
    expect(pp.find("POST", /CAP-S\/refund$/).map((x) => x.headers["PayPal-Request-Id"])).toEqual([`ref-${c.id}-STATE`, `ref-${c.id}-STATE`]);
    const l = await lines(c.id);
    expect([l.FEDERAL.status, l.STATE.status]).toEqual(["REFUNDED", "REFUNDED"]);
    expect(await state(c.id)).toBe("REFUNDED");
  });

  it("state line never captured: refund federal, release the rest", async () => {
    const c = await seedCase({
      state: "REFUND_PROPOSED",
      extra: proposed,
      stateFee: 7_000,
      payment: { captureId: "CAP-F", status: "COMPLETED" },
      lines: [{ kind: "FEDERAL", amount: 18_000, status: "COMPLETED", captureId: "CAP-F" }, { kind: "STATE", amount: 7_000 }],
    });
    pp.on("POST", /CAP-F\/refund$/, { status: 201, body: { id: "REF-F", status: "COMPLETED" } });
    pp.on("POST", /AUTH1\/void$/, { status: 204 });
    expect((await money.refund(c.id, "system")).ok).toBe(true);
    expect((pp.calls[0].body as { amount: { value: string } }).amount.value).toBe("180.00");
    expect((await lines(c.id)).STATE.status).toBe("VOIDED");
  });

  it("refund blocked while the preparer's 72 h window is open", async () => {
    const c = await seedCase({ state: "REFUND_PROPOSED", extra: { ...proposed, refundDeadline: new Date(Date.now() + 3600_000) }, payment: { captureId: "CAP-X" } });
    expect((await money.refund(c.id, "ai")).ok).toBe(false);
    expect(pp.calls).toHaveLength(0);
  });

  it("terminal refund error → REFUND_FAILED", async () => {
    const c = await seedCase({ state: "REFUND_PROPOSED", extra: proposed, payment: { captureId: "CAP-T", status: "COMPLETED" } });
    pp.on("POST", /CAP-T\/refund$/, ppErr(422, "REFUND_NOT_ALLOWED"));
    await money.refund(c.id, "system");
    expect(await state(c.id)).toBe("REFUND_FAILED");
  });
});

describe("multiparty (preparer is the merchant)", () => {
  it("platform fee goes on the capture with PayPal-Auth-Assertion; the refund returns it", async () => {
    process.env.PLATFORM_FEE_CENTS = "400";
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: { payeeMerchantId: "SELLER123" }, lines: [fedLine], merchantId: "SELLER123" });
    pp.on("POST", /AUTH1\/capture$/, { status: 201, body: { id: "CAP-M", status: "COMPLETED" } });
    expect((await money.capture(c.id, "system")).ok).toBe(true);
    const cap = pp.calls[0];
    expect(cap.body).toMatchObject({ payment_instruction: { platform_fees: [{ amount: { value: "4.00" } }] } });
    const [, payload] = cap.headers["PayPal-Auth-Assertion"].split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iss: "test-client", payer_id: "SELLER123" });
    expect((await lines(c.id)).FEDERAL.platformFee).toBe(400);

    await db.case.update({ where: { id: c.id }, data: { state: "REFUND_PROPOSED", refundDeadline: new Date(Date.now() - 1000), clientConfirmedRefund: true } });
    pp.on("POST", /CAP-M\/refund$/, { status: 201, body: { id: "REF-M", status: "COMPLETED" } });
    expect((await money.refund(c.id, "system")).ok).toBe(true);
    const ref = pp.find("POST", /CAP-M\/refund$/)[0];
    expect(ref.body).toMatchObject({ amount: { value: "250.00" }, payment_instruction: { platform_fees: [{ amount: { value: "4.00" } }] } });
    expect(ref.headers["PayPal-Auth-Assertion"]).toBeTruthy();
  });

  it("no platform fee and no assertion in single-account mode", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: {}, lines: [fedLine] });
    pp.on("POST", /AUTH1\/capture$/, { status: 201, body: { id: "CAP-N", status: "COMPLETED" } });
    await money.capture(c.id, "system");
    expect(pp.calls[0].body).toEqual({ final_capture: true });
    expect(pp.calls[0].headers["PayPal-Auth-Assertion"]).toBeUndefined();
  });
});

describe("fee split guard", () => {
  it("locked after authorization", async () => {
    const c = await seedCase({ state: "AUTHORIZED", payment: {} });
    expect((await money.setStateFee(c.id, 5_000)).ok).toBe(false);
  });
  it("allowed before approval; must be below the total", async () => {
    const c = await seedCase({ state: "MATCH" });
    expect((await money.setStateFee(c.id, 30_000)).ok).toBe(false);
    expect((await money.setStateFee(c.id, 5_000)).ok).toBe(true);
    expect(money.feeSplit(await db.case.findUniqueOrThrow({ where: { id: c.id } })).map((l) => l.amountCents)).toEqual([20_000, 5_000]);
  });
});
