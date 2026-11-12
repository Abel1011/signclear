import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { LabCorpus } from "../src/lib/lab/types";
import { isPost } from "../src/lib/lab/types";
import { evaluateCase, isExtraRule, withReason } from "../src/lib/lab/evaluate";
import type { VariantOutcome } from "../src/lib/lab/types";
import { preFilingRules, r14, verdict } from "../src/lib/rules";
import { extraPreFilingRules, normalizeTranscript, sumsOkAllCredits } from "../src/lib/rules-extra";

const dev = JSON.parse(readFileSync("data/lab/corpus.json", "utf8")) as LabCorpus;
const unseen = JSON.parse(readFileSync("data/lab/unseen.json", "utf8")) as LabCorpus;
const all = [...dev.cases, ...unseen.cases];

describe("lab evaluation semantics", () => {
  it("production variant = preFilingRules exactly as engine.ts review() runs it", () => {
    for (const c of all.filter((x) => !isPost(x.scheme))) {
      const v = { ...c.truth, sums_ok: sumsOkAllCredits(c.truth) };
      const f = preFilingRules(c.intake, v, c.preparerKey);
      const o = evaluateCase(c, { ...c.truth }, c.preparerKey).production;
      expect(o.rules, c.key).toEqual(f.map((x) => `${x.rule}:${x.severity}`));
      expect(o.verdict, c.key).toBe(verdict(f));
    }
  });

  it("never applies the extra rules twice (each X finding appears once, as in rules-extra)", () => {
    for (const c of all.filter((x) => !isPost(x.scheme))) {
      const v = { ...c.truth, sums_ok: sumsOkAllCredits(c.truth) };
      const xs = extraPreFilingRules(c.intake, v, { preparerPtin: c.preparerKey }).map((x) => `${x.rule}:${x.severity}`);
      const o = evaluateCase(c, { ...c.truth }, c.preparerKey).production;
      expect(o.rules.filter((r) => isExtraRule(r.split(":")[0])), c.key).toEqual(xs);
    }
  });

  it("core variant = the same findings without X1–X3", () => {
    for (const c of all.filter((x) => !isPost(x.scheme))) {
      const e = evaluateCase(c, { ...c.truth }, c.preparerKey);
      expect(e.core.rules).toEqual(e.production.rules.filter((r) => !isExtraRule(r.split(":")[0])));
      expect(e.core.rules.some((r) => r.startsWith("X"))).toBe(false);
    }
  });

  it("post-filing uses r14 on the normalized transcript, as engine.ts compareTranscript() does", () => {
    for (const c of all.filter((x) => isPost(x.scheme))) {
      const res = r14(c.post!.snapshot, normalizeTranscript({ ...c.truth, deposit_received: c.post!.deposit }));
      const e = evaluateCase(c, { ...c.truth }, c.preparerKey);
      expect(e.production.verdict, c.key).toBe(res.verdict);
      expect(e.core).toEqual(e.production);
    }
  });
});

describe("right-reason detection", () => {
  const o = (rules: string[], detected = true, verdict = "DIFFERENCES"): VariantOutcome => ({ rules, verdict, detected, warnedOnly: false, moneyMovedWrongly: false, paypal: "" });
  it("credits a detection only when a blocking rule also fires on the true values", () => {
    expect(withReason(o(["R3:IMPORTANT"]), o(["R3:IMPORTANT", "X1:IMPORTANT"])).rightReason).toBe(true);
    expect(withReason(o(["R8:IMPORTANT"]), o(["R3:IMPORTANT"])).rightReason).toBe(false); // misread name blocked a mule-account fraud
    expect(withReason(o(["R3:CLARIFY", "R10:CONFIRM"]), o(["R3:CLARIFY"])).rightReason).toBe(false);
    expect(withReason(o(["R14:DIVERTED"], true, "DIVERTED"), o(["R14:DIVERTED"], true, "DIVERTED")).rightReason).toBe(true);
    expect(withReason(o([], true, "READ_FAILED"), o(["R3:IMPORTANT"])).rightReason).toBe(false);
  });
});

describe("unseen held-out set", () => {
  const lock = JSON.parse(readFileSync("data/lab/unseen.lock.json", "utf8")) as { corpusSha256: string; docs: Record<string, string> };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  it("is frozen: corpus and every document match unseen.lock.json", () => {
    expect(sha(readFileSync("data/lab/unseen.json"))).toBe(lock.corpusSha256);
    for (const [doc, h] of Object.entries(lock.docs)) {
      expect(existsSync(`public${doc}`), doc).toBe(true);
      expect(sha(readFileSync(`public${doc}`)), doc).toBe(h);
    }
  });

  it("shares no preparer, client or case key with the dev corpus", () => {
    const devPreps = new Set(dev.preparers.map((p) => p.key));
    const devClients = new Set(dev.cases.map((c) => c.intake.name));
    expect(unseen.preparers.filter((p) => devPreps.has(p.key))).toEqual([]);
    expect(unseen.cases.filter((c) => devClients.has(c.intake.name))).toEqual([]);
    const devKeys = new Set(dev.cases.map((c) => c.key));
    expect(unseen.cases.filter((c) => devKeys.has(c.key))).toEqual([]);
    expect(dev.cases.every((c) => c.split === "dev")).toBe(true);
    expect(unseen.cases.every((c) => c.split === "unseen")).toBe(true);
  });

  it("renders every return in three conditions (clean PDF, scan, phone photo) with identical truth", () => {
    const by = new Map<string, typeof unseen.cases>();
    for (const c of unseen.cases) by.set(c.baseKey!, [...(by.get(c.baseKey!) ?? []), c]);
    for (const [k, cs] of by) {
      expect(cs.map((c) => c.condition).sort(), k).toEqual(["pdf", "photo", "scan"]);
      expect(new Set(cs.map((c) => JSON.stringify(c.truth))).size, k).toBe(1);
    }
  });
});
