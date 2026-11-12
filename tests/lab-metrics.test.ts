import { describe, it, expect } from "vitest";
import { computeMetrics, summarize, costOf } from "../src/lib/lab/metrics";
import type { Condition, LabCaseResult, Scheme, VariantOutcome } from "../src/lib/lab/types";

const o = (detected: boolean, extra: Partial<VariantOutcome> = {}): VariantOutcome => ({ rules: [], verdict: detected ? "DIFFERENCES" : "MATCH", detected, warnedOnly: false, moneyMovedWrongly: false, paypal: "", ...extra });
const r = (scheme: Scheme, condition: Condition, production: VariantOutcome, core = production, reader: [number, number] = [27, 27], latency = 1000, baseKey?: string): LabCaseResult => ({
  caseKey: `${scheme}-${Math.random()}`,
  baseKey,
  scheme,
  split: "unseen",
  condition,
  expected: "",
  preparerKey: "P1",
  production,
  core,
  readerOk: reader[0],
  readerTotal: reader[1],
  readerMisses: [],
  latencyMs: latency,
  tokensIn: 1000,
  tokensOut: 100,
  costUsd: costOf("claude-opus-5-5", 1000, 100),
});

describe("lab metrics", () => {
  const results = [
    r("clean", "pdf", o(false)),
    r("clean", "scan", o(true), o(false)), // false alarm in production only
    r("refund_account", "pdf", o(true), o(true), [27, 27], 1000, "u-ra-1"),
    r("refund_account", "scan", o(false, { verdict: "CLARIFY", warnedOnly: true }), o(false, { verdict: "CLARIFY", warnedOnly: true }), [26, 27], 1000, "u-ra-1"),
    r("injection", "scan", o(true), o(true), [25, 27], 3000),
    r("inflated_credits", "photo", o(false, { moneyMovedWrongly: true }), o(true)),
    r("post_clean", "pdf", o(true, { verdict: "SUBSTITUTED", moneyMovedWrongly: true }), o(false, { verdict: "MATCH" })),
  ];

  it("computes detection, false alarms, money moved wrongly and reader accuracy", () => {
    const m = computeMetrics(results, "production");
    expect(m.fraud).toMatchObject({ n: 4, detected: 2, warnedOnly: 1, moneyMovedWrongly: 1 });
    expect(m.fraud.rate).toBe(0.5);
    expect(m.clean).toMatchObject({ n: 3, falsePositives: 2, moneyMovedWrongly: 1 });
    expect(m.moneyMovedWrongly).toBe(2);
    expect(m.injection).toMatchObject({ n: 1, detected: 1, rate: 1 });
    expect(m.reader.ok).toBe(27 * 5 + 26 + 25);
    expect(m.reader.perfectCases).toBe(5);
    expect(m.perScheme.refund_account).toMatchObject({ n: 2, detected: 1, rate: 0.5, warnedOnly: 1 });
    expect(m.costUsd).toBeCloseTo(7 * ((1000 * 4 + 100 * 20) / 1e6));
  });

  it("splits by document condition, keeps production and core apart, and counts verdict flips across conditions", () => {
    const s = summarize(results);
    expect(s.production.byCondition.pdf!.n).toBe(3);
    expect(s.production.byCondition.scan!.n).toBe(3);
    expect(s.production.byCondition.photo!.n).toBe(1);
    expect(s.core.all.fraud.detected).toBe(3);
    expect(s.core.all.clean.falsePositives).toBe(0);
    expect(s.production.all.clean.falsePositives).toBe(2);
    expect(s.paired).toMatchObject({ returns: 1, verdictFlips: 1 });
    expect(s.paired.flips[0].verdicts).toEqual({ pdf: "DIFFERENCES", scan: "CLARIFY" });
  });

  it("separates honest returns that were blocked from ones that only asked the client to clarify", () => {
    const m = computeMetrics(
      [
        r("clean", "pdf", o(true, { rules: ["R3:IMPORTANT"] })),
        r("clean", "pdf", o(true, { verdict: "NEEDS_CONFIRMATION", rules: ["R1:CONFIRM", "R2:IMPORTANT", "R9:CLARIFY"] })),
        r("clean", "pdf", o(false, { verdict: "CLARIFY", rules: ["X3:CLARIFY"] })),
        r("clean", "pdf", o(false)),
        r("post_clean", "pdf", o(true, { verdict: "DIVERTED", moneyMovedWrongly: true })),
        r("post_clean", "pdf", o(false)),
      ],
      "production",
    );
    expect(m.clean).toMatchObject({ n: 6, falsePositives: 3, preN: 4, blocked: 2, clarified: 1, passed: 1, postN: 2, refundProposed: 1, moneyMovedWrongly: 1 });
    expect(m.clean.causes).toEqual({ R3: 1, R1: 1, R2: 1 });
  });

  it("prices models per million tokens", () => {
    expect(costOf("claude-haiku-5-5", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(costOf("claude-opus-5-5", 8185, 890)).toBeCloseTo(0.05054, 4);
  });
});
