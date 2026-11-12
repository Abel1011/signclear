// Fraud Lab metrics. Pure functions over per-case results (safe to import from client components).
import { isFraud, type Condition, type LabCaseResult, type RuleVariant, type Scheme } from "./types";

/** USD per 1M tokens (input, output). Claude API list prices, 2026-11. */
export const PRICING: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
export const costOf = (model: string, tokensIn: number, tokensOut: number) => {
  const [i, o] = PRICING[model] ?? [4, 20];
  return (tokensIn * i + tokensOut * o) / 1_000_000;
};

export type SchemeStat = { n: number; detected: number; rate: number; warnedOnly: number; moneyMovedWrongly: number };
export type Metrics = {
  n: number;
  /** rightReason: stopped AND backed by a blocking rule that also fires on the true values */
  fraud: { n: number; detected: number; rate: number; rightReason: number; warnedOnly: number; moneyMovedWrongly: number };
  /** Honest controls. falsePositives = blocked (pre-filing) + refund proposed (post-filing).
   *  blocked: approval blocked, no PayPal order until the preparer fixes it or the client confirms (no money lost);
   *  clarified: the client is asked to clarify (CLARIFY) and can approve right away — not a block, nothing held back;
   *  refundProposed: post-filing, R14 proposes refunding an honest fee (the preparer gets 72 h to refute). */
  clean: {
    n: number;
    falsePositives: number;
    rate: number;
    moneyMovedWrongly: number;
    preN: number;
    blocked: number;
    clarified: number;
    passed: number;
    postN: number;
    refundProposed: number;
    /** blocking rules behind the blocked honest returns (rule code → documents) */
    causes: Record<string, number>;
  };
  injection: { n: number; detected: number; rate: number };
  moneyMovedWrongly: number;
  reader: { ok: number; total: number; rate: number; perfectCases: number; cases: number; missFields: Record<string, number> };
  perScheme: Partial<Record<Scheme, SchemeStat>>;
  latency: { p50: number; p95: number };
  tokens: { in: number; out: number };
  costUsd: number;
  errors: number;
};

const pct = (a: number, b: number) => (b ? a / b : 0);
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function computeMetrics(results: LabCaseResult[], variant: RuleVariant): Metrics {
  const fraud = results.filter((r) => isFraud(r.scheme));
  const clean = results.filter((r) => !isFraud(r.scheme));
  const inj = results.filter((r) => r.scheme === "injection");
  const o = (r: LabCaseResult) => r[variant];
  const perScheme: Partial<Record<Scheme, SchemeStat>> = {};
  for (const r of results) {
    const s = (perScheme[r.scheme] ??= { n: 0, detected: 0, rate: 0, warnedOnly: 0, moneyMovedWrongly: 0 });
    s.n++;
    if (o(r).detected) s.detected++;
    if (o(r).warnedOnly) s.warnedOnly++;
    if (o(r).moneyMovedWrongly) s.moneyMovedWrongly++;
  }
  for (const s of Object.values(perScheme)) s!.rate = pct(s!.detected, s!.n);
  const read = results.filter((r) => !r.error && r.readerTotal > 0);
  const ok = read.reduce((a, r) => a + r.readerOk, 0);
  const total = read.reduce((a, r) => a + r.readerTotal, 0);
  const missFields: Record<string, number> = {};
  for (const r of read) for (const m of r.readerMisses) missFields[m.k] = (missFields[m.k] ?? 0) + 1;
  const fd = fraud.filter((r) => o(r).detected).length;
  const fp = clean.filter((r) => o(r).detected).length;
  const cleanPre = clean.filter((r) => r.scheme === "clean");
  const cleanPost = clean.filter((r) => r.scheme === "post_clean");
  const blockedPre = cleanPre.filter((r) => o(r).detected);
  const causes: Record<string, number> = {};
  for (const r of blockedPre) for (const code of new Set(o(r).rules.filter((x) => /:(IMPORTANT|CONFIRM)$/.test(x)).map((x) => x.split(":")[0]))) causes[code] = (causes[code] ?? 0) + 1;
  return {
    n: results.length,
    fraud: { n: fraud.length, detected: fd, rate: pct(fd, fraud.length), rightReason: fraud.filter((r) => o(r).detected && o(r).rightReason).length, warnedOnly: fraud.filter((r) => o(r).warnedOnly).length, moneyMovedWrongly: fraud.filter((r) => o(r).moneyMovedWrongly).length },
    clean: {
      n: clean.length,
      falsePositives: fp,
      rate: pct(fp, clean.length),
      moneyMovedWrongly: clean.filter((r) => o(r).moneyMovedWrongly).length,
      preN: cleanPre.length,
      blocked: blockedPre.length,
      clarified: cleanPre.filter((r) => !o(r).detected && o(r).verdict === "CLARIFY").length,
      passed: cleanPre.filter((r) => o(r).verdict === "MATCH").length,
      postN: cleanPost.length,
      refundProposed: cleanPost.filter((r) => o(r).detected).length,
      causes,
    },
    injection: { n: inj.length, detected: inj.filter((r) => o(r).detected).length, rate: pct(inj.filter((r) => o(r).detected).length, inj.length) },
    moneyMovedWrongly: results.filter((r) => o(r).moneyMovedWrongly).length,
    reader: { ok, total, rate: pct(ok, total), perfectCases: read.filter((r) => r.readerOk === r.readerTotal).length, cases: read.length, missFields },
    perScheme,
    latency: { p50: quantile(read.map((r) => r.latencyMs), 0.5), p95: quantile(read.map((r) => r.latencyMs), 0.95) },
    tokens: { in: results.reduce((a, r) => a + r.tokensIn, 0), out: results.reduce((a, r) => a + r.tokensOut, 0) },
    costUsd: results.reduce((a, r) => a + r.costUsd, 0),
    errors: results.filter((r) => r.error).length,
  };
}

export const CONDITIONS: Condition[] = ["pdf", "scan", "photo"];
export type VariantSummary = { all: Metrics; byCondition: Partial<Record<Condition, Metrics>> };
export type RunSummary = {
  production: VariantSummary;
  core: VariantSummary;
  /** unseen set: the same return in several document conditions — how often the production verdict changes */
  paired: { returns: number; verdictFlips: number; flips: { baseKey: string; verdicts: Partial<Record<Condition, string>> }[] };
};

export function summarize(results: LabCaseResult[]): RunSummary {
  const cond = (c: Condition) => results.filter((r) => (r.condition ?? "pdf") === c);
  const v = (variant: RuleVariant): VariantSummary => {
    const byCondition: VariantSummary["byCondition"] = {};
    for (const c of CONDITIONS) if (cond(c).length) byCondition[c] = computeMetrics(cond(c), variant);
    return { all: computeMetrics(results, variant), byCondition };
  };
  const groups = new Map<string, LabCaseResult[]>();
  for (const r of results) if (r.baseKey) groups.set(r.baseKey, [...(groups.get(r.baseKey) ?? []), r]);
  const flips: RunSummary["paired"]["flips"] = [];
  let returns = 0;
  for (const [baseKey, rs] of groups) {
    if (rs.length < 2) continue;
    returns++;
    if (new Set(rs.map((r) => r.production.verdict)).size > 1) flips.push({ baseKey, verdicts: Object.fromEntries(rs.map((r) => [r.condition, r.production.verdict])) });
  }
  return { production: v("production"), core: v("core"), paired: { returns, verdictFlips: flips.length, flips } };
}
