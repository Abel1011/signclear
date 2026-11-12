// The 90-second story runs the real engine + money guardians step by step; PayPal is mocked at the fetch level.
import { mockPayPal, resetDb } from "./paypal-harness";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import { db } from "../src/lib/db";
import { seedSeat } from "../src/app/api/desk/seats/seed";
import { TOUR_STEPS, runTourStep, tourPosition } from "../src/lib/tour";
import { paypalCall, cachedReadNote } from "../src/lib/paypal-calls";
import { fetchJsonRetry, FRIENDLY_NETWORK } from "../src/lib/fetch-retry";

const pp = mockPayPal();
beforeEach(async () => {
  await resetDb();
  pp.reset();
  process.env.PAYPAL_SEAT_VAULT_ID = "VAULT-1";
});
afterAll(() => db.$disconnect());

function sandbox() {
  pp.on("POST", /\/v2\/checkout\/orders$/, {
    status: 201,
    debugId: "dbg-order",
    body: { id: "O-T1", status: "COMPLETED", payer: { name: { given_name: "María", surname: "González" } }, purchase_units: [{ payments: { authorizations: [{ id: "A-T1", status: "CREATED" }] } }] },
  });
  pp.on("POST", /\/authorizations\/A-T1\/capture$/, { status: 201, debugId: "dbg-cap", body: { id: "C-T1", status: "COMPLETED" } });
  pp.on("POST", /\/captures\/C-T1\/refund$/, { status: 201, debugId: "dbg-ref", body: { id: "R-T1", status: "COMPLETED" } });
}

async function startStory() {
  const r = await seedSeat(`tour-${crypto.randomBytes(4).toString("hex")}`, "fraud", { authorize: null, lang: "en" });
  return db.case.findUniqueOrThrow({ where: { clientToken: r.case.client } });
}

describe("90-second story", () => {
  it("runs end to end: fraud → corrected → authorize → refused early → capture → short → transcript → 72 h → refund", async () => {
    sandbox();
    const c = await startStory();
    expect(c.state).toBe("DIFFERENCES");
    expect(await tourPosition(c.id)).toBe(1);
    const states: string[] = [];
    for (let k = 1; k < TOUR_STEPS.length; k++) {
      const r = await runTourStep(c.id, k);
      expect(r.ok, `${TOUR_STEPS[k].id}: ${r.blocked?.join("; ")}`).toBe(true);
      states.push(r.state);
      expect(await tourPosition(c.id)).toBe(k + 1);
    }
    expect(states).toEqual(["MATCH", "AUTHORIZED", "TRANSMITTED", "TRANSMITTED", "CAPTURED", "INVESTIGATING", "REFUND_PROPOSED", "REFUND_PROPOSED", "REFUNDED"]);
    // The early capture was refused by code, with no PayPal call.
    const blocked = await db.auditEvent.findFirst({ where: { caseId: c.id, actor: "guardian", action: "capture_blocked" } });
    expect(blocked?.detail).toMatch(/IRS confirmation/);
    expect(pp.find("POST", /capture$/)).toHaveLength(1);
    const pay = await db.payment.findUniqueOrThrow({ where: { caseId: c.id } });
    expect([pay.orderId, pay.authorizationId, pay.captureId, pay.refundId]).toEqual(["O-T1", "A-T1", "C-T1", "R-T1"]);
  });

  it("steps are idempotent and cannot be skipped server-side", async () => {
    sandbox();
    const c = await startStory();
    expect((await runTourStep(c.id, 3)).ok).toBe(false); // filing before approval
    expect((await runTourStep(c.id, 1)).state).toBe("MATCH");
    const again = await runTourStep(c.id, 1);
    expect(again.already).toBe(true);
    expect(pp.calls).toHaveLength(0);
  });
});

describe("PayPal call labels", () => {
  const pay = { orderId: "O1", authorizationId: "A1", captureId: "C1", refundId: "R1" };
  it("shows endpoint, object id, Debug-ID and a sandbox link", () => {
    const cap = paypalCall({ actor: "paypal", action: "capture", debugId: "d1", detail: { status: 201, pp: "COMPLETED" } }, pay)!;
    expect(cap).toMatchObject({ endpoint: "POST /v2/payments/authorizations/A1/capture", objectKind: "capture", objectId: "C1", debugId: "d1", httpStatus: 201 });
    expect(cap.link).toContain("C1");
    const rec = paypalCall({ actor: "paypal", action: "authorization_recorded", debugId: "d0", detail: { authorizationId: "A9" } }, pay)!;
    expect(rec.objectId).toBe("A9");
    expect(paypalCall({ actor: "paypal", action: "refund", debugId: null, detail: {} }, pay)!.endpoint).toBe("POST /v2/payments/captures/C1/refund");
    expect(paypalCall({ actor: "ai", action: "capture", debugId: null, detail: {} }, pay)).toBeNull();
  });
  it("labels cached reads honestly", () => {
    expect(cachedReadNote({ actor: "ai", action: "read_document", debugId: null, detail: { mode: "cached", sample: "x.pdf" } })).toMatch(/read live by Claude on first upload; identical file replayed/);
    expect(cachedReadNote({ actor: "ai", action: "read_document", debugId: null, detail: { model: "m" } })).toBeNull();
  });
});

describe("client fetch retry", () => {
  it("retries a network failure, then succeeds", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const r = await fetchJsonRetry("/x", {}, { fetchImpl: f as unknown as typeof fetch, backoffMs: 1 });
    expect(r.json).toEqual({ a: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("gives a friendly message after the last retry", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchJsonRetry("/x", {}, { fetchImpl: f as unknown as typeof fetch, backoffMs: 1, retries: 1 })).rejects.toThrow(FRIENDLY_NETWORK);
  });
  it("does not retry a 4xx", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "no" }), { status: 429 }));
    const r = await fetchJsonRetry("/x", {}, { fetchImpl: f as unknown as typeof fetch, backoffMs: 1 });
    expect(r.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
