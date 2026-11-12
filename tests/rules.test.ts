import { describe, it, expect } from "vitest";
import { preFilingRules, verdict, r14 } from "../src/lib/rules";
import { MARIA_INTAKE as DEMO_INTAKE, MARIA_VALUES, MARIA_TRANSCRIPT } from "../src/lib/fixtures";

// Same answers without the nephew (who triggers the demo clarification).
const MARIA_INTAKE = { ...DEMO_INTAKE, dependents: DEMO_INTAKE.dependents.slice(0, 2) };
import { ackDeadline, D } from "../src/lib/clock";

const PTIN = "P01234567";

describe("pre-filing rules", () => {
  it("María's clean return matches", () => {
    const f = preFilingRules(MARIA_INTAKE, { ...MARIA_VALUES }, PTIN);
    expect(f).toEqual([]);
    expect(verdict(f)).toBe("MATCH");
  });
  it("demo: nephew who stayed 5 months is only a CLARIFY (R5), not a blocker", () => {
    const f = preFilingRules(DEMO_INTAKE, { ...MARIA_VALUES }, PTIN);
    expect(f.map((x) => `${x.rule}:${x.severity}`)).toEqual(["R5:CLARIFY"]);
    expect(verdict(f)).toBe("CLARIFY");
  });
  it("R1/R2: blank paid-preparer section is IMPORTANT", () => {
    const f = preFilingRules(MARIA_INTAKE, { ...MARIA_VALUES, preparer_signed: false, ptin: undefined }, PTIN);
    expect(f.map((x) => x.rule)).toEqual(expect.arrayContaining(["R1", "R2"]));
    expect(verdict(f)).toBe("DIFFERENCES");
  });
  it("R5: more dependents than the client told us", () => {
    const f = preFilingRules(MARIA_INTAKE, { ...MARIA_VALUES, dependents_count: 3 }, PTIN);
    expect(f.find((x) => x.rule === "R5")?.severity).toBe("IMPORTANT");
  });
  it("R3: refund to an account that is not the client's", () => {
    const f = preFilingRules(MARIA_INTAKE, { ...MARIA_VALUES, refund_acct_last4: "9999" }, PTIN);
    expect(f.some((x) => x.rule === "R3")).toBe(true);
  });
  it("R6: fuel credit the client never mentioned", () => {
    const f = preFilingRules(MARIA_INTAKE, { ...MARIA_VALUES, fuel_credit_4136: 50_000 }, PTIN);
    expect(f.some((x) => x.rule === "R6")).toBe(true);
  });
  it("R6b: ITIN filer with EITC/CTC", () => {
    const f = preFilingRules({ ...MARIA_INTAKE, idType: "ITIN" }, { ...MARIA_VALUES }, PTIN);
    expect(f.some((x) => x.rule === "R6b")).toBe(true);
  });
  it("R11: Form 8879 amounts differ from the return beyond tolerance", () => {
    const f = preFilingRules(MARIA_INTAKE, { ...MARIA_VALUES, f8879_refund: 520_000 }, PTIN);
    expect(f.some((x) => x.rule === "R11")).toBe(true);
  });
  it("R11 tolerance: $10 difference is fine", () => {
    const f = preFilingRules(MARIA_INTAKE, { ...MARIA_VALUES, f8879_refund: 773_900 }, PTIN);
    expect(f.some((x) => x.rule === "R11")).toBe(false);
  });
});

describe("R14 post-filing transcript check", () => {
  const snap = { ...MARIA_VALUES };
  it("detects diversion: IRS issued the approved refund but less reached the account", () => {
    expect(r14(snap, { ...MARIA_TRANSCRIPT, deposit_received: 472_900 }).verdict).toBe("DIVERTED");
  });
  it("legit offset (826/898) is explained, not refunded", () => {
    expect(r14(snap, { ...MARIA_TRANSCRIPT, tx_898: 300_000, deposit_received: 472_900 }).verdict).toBe("LEGIT_OFFSET");
  });
  it("a small offset cannot hide a diversion (deposit is reconciled arithmetically)", () => {
    expect(r14(snap, { ...MARIA_TRANSCRIPT, tx_898: 1_000, deposit_received: 472_900 }).verdict).toBe("DIVERTED");
  });
  it("an IRS correction (code 290) is explained, never refunded", () => {
    expect(r14(snap, { ...MARIA_TRANSCRIPT, tx_846: 650_000, tx_290: 122_900, deposit_received: 650_000 }).verdict).toBe("IRS_ADJUSTED");
  });
  it("detects substitution: a different return was filed", () => {
    expect(r14(snap, { ...MARIA_TRANSCRIPT, tx_846: 605_000, deposit_received: 605_000 }).verdict).toBe("SUBSTITUTED");
  });
  it("matches when everything arrived", () => {
    expect(r14(snap, { ...MARIA_TRANSCRIPT, deposit_received: 772_900 }).verdict).toBe("MATCH");
  });
});

describe("IRS confirmation deadline", () => {
  it("never exceeds the PayPal authorization life", () => {
    const now = new Date("2026-11-11T00:00:00Z");
    const season = new Date("2027-01-26T00:00:00Z");
    const d = ackDeadline(now, season, now);
    expect(d.getTime() - now.getTime()).toBeLessThanOrEqual(28 * D);
  });
  it("is approval + 5 days when the season is open", () => {
    const now = new Date("2027-02-01T00:00:00Z");
    expect(ackDeadline(now, new Date("2027-01-26T00:00:00Z"), now).getTime()).toBe(now.getTime() + 5 * D);
  });
});
