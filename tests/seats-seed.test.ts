// Judge seats are seeded with the real engine against the local SQLite DB; PayPal is mocked.
import { describe, it, expect, vi, afterAll } from "vitest";
import crypto from "node:crypto";

vi.mock("../src/lib/money", async (orig) => {
  const real = await orig<typeof import("../src/lib/money")>();
  const { db } = await import("../src/lib/db");
  const { loadValues } = await import("../src/lib/engine");
  return {
    ...real,
    // Mock of Builder C's sandbox authorization: same DB effects as recordAuthorization.
    seatAuthorize: vi.fn(async (caseId: string) => {
      const draft = await loadValues(caseId, ["DRAFT_1040"]);
      const r = await db.case.updateMany({ where: { id: caseId, state: "MATCH" }, data: { state: "AUTHORIZED", approvedAt: new Date(), ackDeadline: new Date(Date.now() + 5 * 86400_000) } });
      if (r.count !== 1) return { ok: false, blocked: ["not MATCH"] };
      await db.approvedSnapshot.upsert({ where: { caseId }, create: { caseId, data: JSON.stringify(draft) }, update: { data: JSON.stringify(draft) } });
      await db.payment.upsert({
        where: { caseId },
        create: { caseId, orderId: "ORDER-MOCK", authorizationId: "AUTH-MOCK", amount: 25_000, status: "AUTHORIZED", expirationTime: new Date(Date.now() + 29 * 86400_000) },
        update: {},
      });
      return { ok: true };
    }),
    capture: vi.fn(async (caseId: string) => {
      const c = await db.case.findUniqueOrThrow({ where: { id: caseId }, include: { payment: true, preparer: true } });
      const fails = real.captureConditions(c);
      if (fails.length) return { ok: false, blocked: fails };
      await db.payment.update({ where: { caseId }, data: { captureId: "CAP-MOCK", status: "COMPLETED" } });
      await db.case.update({ where: { id: caseId }, data: { state: "CAPTURED", capturedAt: new Date() } });
      return { ok: true };
    }),
  };
});

const { seedSeat, seatOf, findSeatAuthorize } = await import("../src/app/api/desk/seats/seed");
const { db } = await import("../src/lib/db");
const session = `test-seats-${crypto.randomBytes(4).toString("hex")}`;

afterAll(async () => {
  const ids = (await db.case.findMany({ where: { demoSession: { startsWith: "test-seats-" } }, select: { id: true } })).map((c) => c.id);
  for (const t of [db.auditEvent, db.notification, db.finding, db.extractedValue, db.chatMessage, db.payment, db.approvedSnapshot, db.intake, db.document, db.feeLine] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }[])
    await t.deleteMany({ where: { caseId: { in: ids } } });
  await db.case.deleteMany({ where: { id: { in: ids } } });
});

describe("judge seats", () => {
  it("fraud seat: R3 flags the foreign refund account and nothing is held", async () => {
    const r = await seedSeat(session, "fraud", { authorize: null });
    expect(r.state).toBe("DIFFERENCES");
    expect(r.reached).toBe(true);
    const c = await db.case.findUniqueOrThrow({ where: { clientToken: r.case.client }, include: { findings: true, payment: true } });
    expect(c.scenario).toBe("seat-fraud");
    expect(seatOf(c.scenario)).toBe("fraud");
    expect(c.findings.map((f) => `${f.rule}:${f.severity}:${f.rowKey}`)).toEqual(["R3:IMPORTANT:refund_account"]);
    expect(c.payment).toBeNull();
    expect(r.kicks.map((k) => k.event)).toEqual(["review_ready"]);
  });

  it("clean seat: MATCH, ready to approve with PayPal", async () => {
    const r = await seedSeat(session, "clean", { authorize: null });
    expect(r.state).toBe("MATCH");
    const c = await db.case.findUniqueOrThrow({ where: { clientToken: r.case.client }, include: { findings: true } });
    expect(c.findings).toHaveLength(0);
  });

  it("collect seat: AUTHORIZED then TRANSMITTED with a valid Submission ID (seatAuthorize available)", async () => {
    const auth = await findSeatAuthorize();
    expect(auth).toBeTypeOf("function");
    const r = await seedSeat(session, "collect");
    expect(r).toMatchObject({ reached: true, state: "TRANSMITTED" });
    const c = await db.case.findUniqueOrThrow({ where: { clientToken: r.case.client }, include: { payment: true } });
    expect(c.submissionId).toMatch(/^123456\d{7}[0-9a-z]{7}$/);
    expect(c.ackReceivedAt).toBeNull();
    expect(c.payment?.status).toBe("AUTHORIZED");
  });

  it("collect seat without seatAuthorize falls back to MATCH with a note", async () => {
    const r = await seedSeat(session, "collect", { authorize: null });
    expect(r).toMatchObject({ reached: false, state: "MATCH", target: "TRANSMITTED" });
    expect(r.note).toMatch(/PayPal/);
  });

  it("short seat: collected after the IRS confirmation, then the refund arrives $3,000 short", async () => {
    const r = await seedSeat(session, "short");
    expect(r).toMatchObject({ reached: true, state: "INVESTIGATING" });
    const c = await db.case.findUniqueOrThrow({ where: { clientToken: r.case.client }, include: { payment: true, snapshot: true } });
    expect(c.payment?.status).toBe("COMPLETED");
    expect(c.refundReportedAmount).toBe(472_900);
    expect(JSON.parse(c.snapshot!.data).refund).toBe(772_900);
    expect(r.kicks[r.kicks.length - 1]).toMatchObject({ event: "refund_reported", payload: { received: 472_900, approved: 772_900 } });

    // Before the transcript: the refund row already shows the gap (approved vs received), never "MATCH".
    const { caseView } = await import("../src/lib/view");
    const before = await caseView(c.id, "client");
    const refundRow = before.rows.find((x) => x.key === "refund")!;
    expect(refundRow.status).toBe("DIFFERENT");
    expect(refundRow.declaration).toBe("$7,729.00");
    expect(refundRow.bank).toBe("$4,729.00");
    expect(before.sample).toBe(true);

    // Transcript: IRS issued the full $7,729 (846, no 826/898); the filed Form 8888 sent $3,000 to ****9931,
    // which the approved snapshot didn't have → R14 DIVERTED, fee refund proposed, evidence stated plainly.
    const { uploadTranscript, loadFiledSplit } = await import("../src/lib/engine");
    const up = await uploadTranscript(c.id);
    expect(up.ok).toBe(true);
    expect(await loadFiledSplit(c.id)).toMatchObject({ acct: "9931", amount: 300_000, mainAcct: "1234", mainAmount: 472_900 });
    const after = await caseView(c.id, "client");
    expect(after.state).toBe("REFUND_PROPOSED");
    const r14 = after.findings.find((f) => f.rule === "R14")!;
    expect(r14.message.en).toMatch(/code 846/);
    expect(r14.message.en).toMatch(/Form 8888 that sent \$3,000\.00 to account \*{4}9931/);
    expect(r14.message.en).toMatch(/had no Form 8888/);
    const acct = after.rows.find((x) => x.key === "refund_account")!;
    expect(acct.status).toBe("DIFFERENT");
    expect(acct.irs).toContain("****9931 $3,000.00");
  });
});
