import { describe, it, expect } from "vitest";
import { preFilingRules, sameName } from "../src/lib/rules";
import { toValues } from "../src/lib/reader";
import { MARIA_INTAKE, MARIA_VALUES } from "../src/lib/fixtures";

const I = { ...MARIA_INTAKE, dependents: MARIA_INTAKE.dependents.slice(0, 2) };
describe("rule fixes from the unseen lab", () => {
  it("names printed LAST, FIRST or with a middle initial are the same person", () => {
    expect(sameName("GONZALEZ, MARIA", "María González")).toBe(true);
    expect(sameName("María E. González", "María González")).toBe(true);
    expect(sameName("Carlos Ruiz", "María González")).toBe(false);
  });
  it("a refund with no readable deposit account is blocked (3-way Form 8888)", () => {
    const f = preFilingRules(I, { ...MARIA_VALUES, refund_acct_last4: undefined, refund_acct_type: undefined, f8888_multiple: true }, "P01234567");
    expect(f.some((x) => x.rule === "R3" && x.severity === "IMPORTANT")).toBe(true);
  });
  it("a draft with no paid-preparer section / PTIN can't be confirmed away by the client (ghost preparer)", () => {
    const f = preFilingRules(I, { ...MARIA_VALUES, ptin: undefined, preparer_signed: false, is_draft: true }, "P01234567");
    expect(f.find((x) => x.rule === "R1")?.severity).toBe("IMPORTANT");
    expect(f.find((x) => x.rule === "R2")?.severity).toBe("IMPORTANT");
  });
  it("a single shared surname is not the same person", () => {
    expect(sameName("LOPEZ", "José López")).toBe(false);
    expect(sameName("José López", "José María López")).toBe(true);
  });
  it("'$(1,234)' is negative and credits can't be negative", () => {
    expect(toValues([{ label: "schedule_c_net", value: "$(1,234.00)" }]).schedule_c_net).toBe(-123400);
    expect(toValues([{ label: "eitc", value: "(6,000.00)" }]).eitc).toBe(600000);
  });
  it("transcript credits in parentheses are read as negatives", () => {
    expect(toValues([{ label: "tx_806", value: "(920.00)" }]).tx_806).toBe(-92000);
  });
});
