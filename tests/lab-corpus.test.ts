import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import type { LabCorpus } from "../src/lib/lab/types";
import { isFraud, isPost } from "../src/lib/lab/types";
import { evaluateCase } from "../src/lib/lab/evaluate";
import { computeReturn } from "../src/lib/lab/tax2025";

const corpus = JSON.parse(readFileSync("data/lab/corpus.json", "utf8")) as LabCorpus;

describe("lab corpus labels", () => {
  it("has ~100 unique cases with PDFs, ~1/3 clean controls", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(95);
    expect(new Set(corpus.cases.map((c) => c.key)).size).toBe(corpus.cases.length);
    for (const c of corpus.cases) expect(existsSync(`public${c.pdf}`)).toBe(true);
    const clean = corpus.cases.filter((c) => !isFraud(c.scheme)).length;
    expect(clean).toBeGreaterThanOrEqual(30);
    expect(corpus.cases.length - clean).toBeGreaterThanOrEqual(60);
  });

  it("v1 is development data only (rules-extra was written alongside it); the held-out test is data/lab/unseen.json", () => {
    expect(corpus.cases.every((c) => c.split === "dev")).toBe(true);
  });

  it("every return PDF is internally coherent (refund = payments − total tax)", () => {
    for (const c of corpus.cases.filter((x) => !isPost(x.scheme))) {
      const v = c.truth;
      const expected = (v.withholding ?? 0) + (v.eitc ?? 0) + (v.actc ?? 0) + (v.aotc ?? 0) + (v.fuel_credit_4136 ?? 0) - (v.total_tax ?? 0);
      expect(v.refund, c.key).toBe(expected);
      expect(v.refund!, c.key).toBeGreaterThan(0);
    }
  });

  it("clean controls agree with the interview (identity, account, dependents)", () => {
    for (const c of corpus.cases.filter((x) => x.scheme === "clean")) {
      expect(c.truth.taxpayer_name).toBe(c.intake.name);
      expect(c.truth.ssn_last4).toBe(c.intake.last4);
      expect(c.truth.refund_acct_last4).toBe(c.intake.refundAcctLast4);
      expect(c.truth.ptin).toBe(c.preparerKey);
      expect(c.truth.dependents_count).toBe(c.intake.dependents.filter((d) => d.months > 6).length);
    }
  });

  it("TY2025 math reproduces the hand-checked María sample", () => {
    const r = computeReturn({ filing: "hoh", idType: "SSN", wages: 18_400, withholding: 920, seNet: 14_200, eitcKids: 2, ctcKids: 2 });
    expect([r.agi, r.eitc, r.ctc, r.actc, r.totalTax, r.refund]).toEqual([31_597, 5_415, 797, 3_400, 2_006, 7_729]);
  });

  it("oracle (perfect reader): production rules block every dev fraud except the documented misses; no clean control blocked", () => {
    const misses: string[] = [];
    const falseAlarms: string[] = [];
    for (const c of corpus.cases) {
      const o = evaluateCase(c, { ...c.truth }, c.preparerKey).production;
      if (isFraud(c.scheme) && !o.detected) misses.push(`${c.key}:${c.variant}`);
      if (!isFraud(c.scheme) && o.detected) falseAlarms.push(c.key);
      if (isPost(c.scheme) && !["SUBSTITUTED", "DIVERTED"].includes(c.expected)) expect(o.verdict, c.key).toBe(c.expected);
    }
    expect(falseAlarms).toEqual([]);
    // Known, reported limitations: Form 8888 split (reader sees one account) and an EITC overstatement
    // that stays under the most generous (MFJ) table because filing status is not asked.
    for (const m of misses) expect(m).toMatch(/form-8888-split|eitc-overstated/);
    expect(misses.length).toBeLessThanOrEqual(3);
  });
});
