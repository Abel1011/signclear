// Regression (C2): an Agent Arena run must never change how REAL cases talk to PayPal.
// The simulator is chosen per case (paypalSim flag); nothing global is patched; arguments are forwarded faithfully.
import { mockPayPal, resetDb, seedCase, transmitted } from "./paypal-harness";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as money from "../src/lib/money";
import { paypal, paypalRest } from "../src/lib/paypal";
import { db } from "../src/lib/db";

const pp = mockPayPal();
beforeEach(async () => {
  await resetDb();
  pp.reset();
  delete process.env.MULTIPARTY;
  delete process.env.PLATFORM_FEE_CENTS;
});
afterAll(() => db.$disconnect());

const split = { stateFee: 7_000, lines: [{ kind: "FEDERAL", amount: 18_000 }, { kind: "STATE", amount: 7_000 }] };

async function arenaRun() {
  // An Arena case: authorization + partial capture entirely on the simulator, no PayPal HTTP call.
  const a = await seedCase({ state: "MATCH", stateFee: 7_000, extra: { paypalSim: true, demoSession: "arena" } });
  const o = await money.createOrder(a.id, { card: true });
  expect(o).toMatchObject({ ok: true, authorized: true });
  const pay = await db.payment.findUniqueOrThrow({ where: { caseId: a.id } });
  expect(pay.authorizationId).toMatch(/^ARENA-SIM-AUTH-/);
  await db.case.update({ where: { id: a.id }, data: { state: "TRANSMITTED", ...transmitted } });
  expect((await money.capture(a.id, "system")).ok).toBe(true);
  const fed = await db.feeLine.findFirstOrThrow({ where: { caseId: a.id, kind: "FEDERAL" } });
  expect(fed.captureId).toMatch(/^ARENA-SIM-CAP-/);
  expect(pp.calls).toHaveLength(0);
  return a;
}

describe("Arena PayPal simulator is per case, never global", () => {
  it("does not replace the exported client", () => {
    expect(paypal.capture).not.toBe(undefined);
    // The REST client stays the REST client.
    expect(paypalRest.capture.toString()).toContain("/v2/payments/authorizations/");
  });

  it("after an Arena run, a real federal capture is still PARTIAL (amount + final_capture=false) and the state capture goes through", async () => {
    await arenaRun();
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: { attempt: 1 }, ...split });
    pp.on("POST", /AUTH1\/capture$/, { status: 201, body: { id: "CAP-F", status: "COMPLETED" } }, { status: 201, body: { id: "CAP-S", status: "COMPLETED" } });
    expect((await money.capture(c.id, "system")).ok).toBe(true);
    expect(pp.calls[0].body).toEqual({ final_capture: false, amount: { currency_code: "USD", value: "180.00" }, invoice_id: `FC-${c.id}-1-FED` });
    const r = await money.stateAckReceived(c.id);
    expect(r.ok).toBe(true);
    expect(pp.calls[1].body).toMatchObject({ final_capture: true, amount: { value: "70.00" } });
    expect((await db.feeLine.findFirstOrThrow({ where: { caseId: c.id, kind: "STATE" } })).status).toBe("COMPLETED");
  });

  it("after an Arena run, a real multiparty refund keeps platform_fees and the merchant assertion", async () => {
    await arenaRun();
    process.env.PLATFORM_FEE_CENTS = "400";
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: { payeeMerchantId: "SELLER123" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "AUTHORIZED" }], merchantId: "SELLER123" });
    pp.on("POST", /AUTH1\/capture$/, { status: 201, body: { id: "CAP-M", status: "COMPLETED" } });
    expect((await money.capture(c.id, "system")).ok).toBe(true);
    expect(pp.calls[0].body).toMatchObject({ payment_instruction: { platform_fees: [{ amount: { value: "4.00" } }] } });
    expect(pp.calls[0].headers["PayPal-Auth-Assertion"]).toBeTruthy();
    await db.case.update({ where: { id: c.id }, data: { state: "REFUND_PROPOSED", refundDeadline: new Date(Date.now() - 1000), clientConfirmedRefund: true } });
    pp.on("POST", /CAP-M\/refund$/, { status: 201, body: { id: "REF-M", status: "COMPLETED" } });
    expect((await money.refund(c.id, "system")).ok).toBe(true);
    const ref = pp.find("POST", /CAP-M\/refund$/)[0];
    expect(ref.body).toMatchObject({ amount: { value: "250.00" }, payment_instruction: { platform_fees: [{ amount: { value: "4.00" } }] } });
    expect(ref.headers["PayPal-Auth-Assertion"]).toBeTruthy();
  });

  it("the simulator honours partial capture arguments for Arena cases too", async () => {
    const a = await arenaRun();
    const auth = (await db.payment.findUniqueOrThrow({ where: { caseId: a.id } })).authorizationId!;
    const audit = await db.auditEvent.findFirstOrThrow({ where: { caseId: a.id, action: "capture" } });
    expect(JSON.parse(audit.detail)).toMatchObject({ partial: true, finalCapture: false });
    const { arenaPaypal } = await import("../src/lib/arena/paypal-sim");
    const st = await arenaPaypal.capture(auth, "sim-state", { amountCents: 7_000, finalCapture: true, platformFeeCents: 100, merchantId: "M1" });
    expect(st.body).toMatchObject({ final_capture: true, amount: { value: "70.00" }, payee: { merchant_id: "M1" } });
    expect((await arenaPaypal.capture(auth, "sim-again", { amountCents: 100 })).ok).toBe(false); // authorization closed
    expect(pp.calls).toHaveLength(0);
  });

  it("a simulator id on a case that is NOT flagged is refused, never simulated", async () => {
    const c = await seedCase({ state: "TRANSMITTED", extra: transmitted, payment: { authorizationId: "ARENA-SIM-AUTH-FAKE" }, lines: [{ kind: "FEDERAL", amount: 25_000, status: "AUTHORIZED" }] });
    const res = await paypal.capture("ARENA-SIM-AUTH-FAKE", "x", {});
    expect(res.ok).toBe(false);
    expect((res.body as { name: string }).name).toBe("SIMULATED_ID_OUTSIDE_ARENA");
    void c;
  });
});
