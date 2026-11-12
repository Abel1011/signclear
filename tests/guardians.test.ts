import { describe, it, expect } from "vitest";
import { captureConditions, refundConditions } from "../src/lib/money";

const base = {
  id: "c1",
  state: "TRANSMITTED",
  version: 3,
  clockOffsetMs: 0,
  ackReceivedAt: new Date(),
  ackDeadline: new Date(Date.now() + 86400_000),
  submissionId: "12345620270281a2b3c4",
  capturedAt: new Date(),
  refundDeadline: new Date(Date.now() - 1000),
  preparerVerdict: null as string | null,
  clientConfirmedRefund: true,
  preparer: { efin: "123456" },
  payment: { authorizationId: "AUTH", captureId: "CAP", expirationTime: new Date(Date.now() + 10 * 86400_000) },
};
type C = Parameters<typeof captureConditions>[0];

describe("capture guardian", () => {
  it("allows capture with an Accepted confirmation from the preparer's EFIN", () => {
    expect(captureConditions(base as unknown as C)).toEqual([]);
  });
  it("blocks capture without IRS confirmation (Try to break it)", () => {
    const f = captureConditions({ ...base, ackReceivedAt: null } as unknown as C);
    expect(f.join(" ")).toMatch(/R13/);
  });
  it("blocks capture when the Submission ID is not from the preparer's EFIN", () => {
    expect(captureConditions({ ...base, submissionId: "99999920270281a2b3c4" } as unknown as C).join(" ")).toMatch(/EFIN/);
  });
  it("blocks capture before transmission", () => {
    expect(captureConditions({ ...base, state: "AUTHORIZED" } as unknown as C).length).toBeGreaterThan(0);
  });
  it("blocks capture of an expired authorization", () => {
    expect(captureConditions({ ...base, payment: { ...base.payment, expirationTime: new Date(Date.now() - 1000) } } as unknown as C).join(" ")).toMatch(/expired/);
  });
});

describe("refund guardian", () => {
  const r = { ...base, state: "REFUND_PROPOSED" };
  it("allows refund: proposed + window over + client confirmed", () => {
    expect(refundConditions(r as unknown as C)).toEqual([]);
  });
  it("blocks while the preparer's 72 h window is open", () => {
    expect(refundConditions({ ...r, refundDeadline: new Date(Date.now() + 3600_000) } as unknown as C).join(" ")).toMatch(/72 h/);
  });
  it("blocks when the preparer refuted the finding", () => {
    expect(refundConditions({ ...r, preparerVerdict: "REFUTED" } as unknown as C).join(" ")).toMatch(/refuted/);
  });
  it("blocks without client confirmation", () => {
    expect(refundConditions({ ...r, clientConfirmedRefund: false } as unknown as C).join(" ")).toMatch(/client/);
  });
});

describe("refund guardian vs. the preparer's reply", () => {
  const prop = { ...base, state: "REFUND_PROPOSED" };
  it("an unproven reply (INCONCLUSIVE) does not block the refund once the 72 h are over", () => {
    expect(refundConditions({ ...prop, preparerVerdict: "INCONCLUSIVE" } as unknown as C)).toEqual([]);
  });
  it("an unproven reply cannot be used to refund before the 72 h end", () => {
    expect(refundConditions({ ...prop, preparerVerdict: "INCONCLUSIVE", refundDeadline: new Date(Date.now() + 3600_000) } as unknown as C).join(" ")).toMatch(/72 h/);
  });
  it("refuted by evidence blocks the refund (human review)", () => {
    expect(refundConditions({ ...prop, preparerVerdict: "REFUTED" } as unknown as C).join(" ")).toMatch(/refuted/);
  });
});
