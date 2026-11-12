// Fraud Lab — re-score the stored reads with the CURRENT production rules. NO model calls.
//
// The recorded runs (data/lab/results-<model>-<corpus>.json) were scored with the rules frozen at run time
// (commit MEASURED_AT). Afterwards the rules were changed using what the unseen set exposed, so the unseen
// set is no longer unseen for them. This script takes the SAME cached reads (data/lab/reads-*.json, the raw
// rows the reader returned) and runs today's toValues + preFilingRules / r14 on them, writing
// data/lab/rescored-<model>-<corpus>.json. Those numbers are labeled "current rules (re-scored)", never "unseen".
//
// It also freezes the "as measured" radar: the radar scored with the rules as they were at MEASURED_AT on the
// values recorded at run time (data/lab/radar-as-measured.json). The frozen rule files are read from git.
//
// Run: node node_modules/tsx/dist/cli.mjs scripts/lab/rescore.mts
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LabCorpus, LabCaseResult, LabCase } from "../../src/lib/lab/types.ts";
import { MEASURED_AT } from "../../src/lib/lab/types.ts";
import { toValues, accuracy } from "../../src/lib/reader.ts";
import { evaluateCase, outcomeFor, withReason } from "../../src/lib/lab/evaluate.ts";
import { summarize, costOf } from "../../src/lib/lab/metrics.ts";
import { radarEval } from "../../src/lib/lab/data.ts";

type Read = { rows: { label: string; value: string }[]; latencyMs: number; tokensIn: number; tokensOut: number };
const corpora: Record<"dev" | "unseen", LabCorpus> = {
  dev: JSON.parse(readFileSync("data/lab/corpus.json", "utf8")),
  unseen: JSON.parse(readFileSync("data/lab/unseen.json", "utf8")),
};
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "oracle"];
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const at = new Date().toISOString();

function rescoreOne(c: LabCase, read: Read | null, model: string): LabCaseResult {
  const oracle = model === "oracle";
  const truth = { ...c.truth } as Record<string, unknown>;
  delete truth.sums_ok;
  const error = !oracle && !read ? "no cached read for this document (it was never read)" : undefined;
  const values = oracle ? { ...c.truth } : read ? toValues(read.rows) : {};
  let ev = evaluateCase(c, values, c.preparerKey);
  if (error) {
    const o = outcomeFor(c, "READ_FAILED", []);
    ev = { production: { ...o, rightReason: false }, core: { ...o, rightReason: false }, values: {} };
  } else {
    const t = evaluateCase(c, { ...c.truth }, c.preparerKey);
    ev = { ...ev, production: withReason(ev.production, t.production), core: withReason(ev.core, t.core) };
  }
  const acc = error ? { ok: 0, total: 0 } : accuracy(values, truth as never);
  const nz = (x: unknown) => (x === undefined || x === 0 || x === false ? null : x);
  const misses = error ? [] : Object.keys(truth).filter((k) => JSON.stringify(nz((values as Record<string, unknown>)[k])) !== JSON.stringify(nz(truth[k]))).map((k) => ({ k, read: (values as Record<string, unknown>)[k] ?? null, truth: truth[k] ?? null }));
  return {
    caseKey: c.key,
    baseKey: c.baseKey,
    scheme: c.scheme,
    split: c.split,
    condition: c.condition ?? "pdf",
    expected: c.expected,
    preparerKey: c.preparerKey,
    error,
    production: ev.production,
    core: ev.core,
    readerOk: acc.ok,
    readerTotal: acc.total,
    readerMisses: misses,
    latencyMs: read?.latencyMs ?? 0,
    tokensIn: read?.tokensIn ?? 0,
    tokensOut: read?.tokensOut ?? 0,
    costUsd: read && !oracle ? costOf(model, read.tokensIn, read.tokensOut) : 0,
    values: ev.values,
  };
}

const fmt = (s: ReturnType<typeof summarize>["production"]["all"]) =>
  `fraud stopped ${s.fraud.detected}/${s.fraud.n} · controls: blocked ${s.clean.blocked}/${s.clean.preN}, clarify ${s.clean.clarified}/${s.clean.preN}, refund proposed ${s.clean.refundProposed}/${s.clean.postN} · money wrong ${s.moneyMovedWrongly}`;

for (const corpus of ["unseen", "dev"] as const) {
  for (const model of MODELS) {
    const measuredFile = `data/lab/results-${model}-${corpus}.json`;
    if (!existsSync(measuredFile)) continue;
    const measured = JSON.parse(readFileSync(measuredFile, "utf8")) as { run: Record<string, unknown>; results: LabCaseResult[] };
    const oracle = model === "oracle";
    const cacheFile = corpus === "unseen" ? `data/lab/reads-${model}-unseen.json` : `data/lab/reads-${model}.json`;
    const cache: Record<string, Read> = oracle ? {} : JSON.parse(readFileSync(cacheFile, "utf8"));
    // Same population as the recorded run (a partial run stays partial): no new reads.
    const byKey = new Map(corpora[corpus].cases.map((c) => [c.key, c]));
    const results = measured.results.map((m) => {
      const c = byKey.get(m.caseKey)!;
      const r = rescoreOne(c, oracle ? null : (cache[c.key] ?? null), model);
      // keep the recorded read cost/latency (the read itself is not repeated)
      return { ...r, costUsd: m.costUsd, latencyMs: m.latencyMs, tokensIn: m.tokensIn, tokensOut: m.tokensOut };
    });
    const summary = summarize(results);
    const run = {
      ...measured.run,
      summary,
      rescored: { at, rulesAt: head, measuredAt: MEASURED_AT, newModelCalls: 0, note: "Same cached reads as the recorded run, scored with the current production rules. Not an unseen measurement: the rules were changed after seeing this set." },
    };
    writeFileSync(`data/lab/rescored-${model}-${corpus}.json`, JSON.stringify({ run, results }, null, 1));
    const before = summarize(measured.results).production.all;
    console.log(`${corpus.padEnd(6)} ${model.padEnd(18)} measured: ${fmt(before)}\n${"".padEnd(26)}current:  ${fmt(summary.production.all)}`);
  }
}

// ------------------------------------------------------------------ "as measured" radar (frozen rules from git)
const FROZEN = ["src/lib/rules.ts", "src/lib/rules-extra.ts", "src/lib/i18n.ts", "src/lib/brand.ts", "src/lib/lab/tax2025.ts", "src/lib/radar.ts"];
const tmp = path.resolve("data/lab/.frozen-rules-tmp");
rmSync(tmp, { recursive: true, force: true });
for (const f of FROZEN) {
  const out = path.join(tmp, f);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, execFileSync("git", ["show", `${MEASURED_AT}:${f}`]));
}
try {
  const frozen = (await import(pathToFileURL(path.join(tmp, "src/lib/radar.ts")).href)) as typeof import("../../src/lib/radar.ts");
  const views: unknown[] = [];
  for (const corpus of ["unseen", "dev"] as const) {
    const c = corpora[corpus];
    const name = Object.fromEntries(c.preparers.map((p) => [p.key, `${p.name} · ${p.firm}`]));
    const pop = (cond: string, values: (x: LabCase) => Record<string, unknown> | null) =>
      c.cases
        .filter((x) => !x.scheme.startsWith("post_") && (x.condition ?? "pdf") === (cond === "truth" ? "pdf" : cond))
        .flatMap((x) => {
          const v = values(x);
          return v ? [frozen.toRadarCase({ caseKey: x.baseKey ?? x.key, preparerKey: x.preparerKey, preparerName: name[x.preparerKey], intake: x.intake, values: v })] : [];
        });
    const push = (model: string, cond: string, p: ReturnType<typeof pop>, label: string) => {
      if (!p.length) return;
      const result = frozen.scoreRadar(p);
      views.push({ id: `${corpus}|${model}|${cond}`, corpus, model, condition: cond, label, result, eval: radarEval(result, c.preparers), cases: p.length });
    };
    for (const model of MODELS.filter((m) => m !== "oracle")) {
      const f = `data/lab/results-${model}-${corpus}.json`;
      if (!existsSync(f)) continue;
      const rs = (JSON.parse(readFileSync(f, "utf8")) as { results: LabCaseResult[] }).results;
      const byKey = new Map(rs.map((r) => [r.caseKey, r]));
      for (const cond of [...new Set(rs.map((r) => r.condition ?? "pdf"))])
        push(model, cond, pop(cond, (x) => { const r = byKey.get(x.key); return r && !r.error && r.values ? (r.values as Record<string, unknown>) : null; }), `${model} · ${cond}`);
    }
    push("truth", "truth", pop("truth", (x) => x.truth as Record<string, unknown>), "ground-truth values (no reader)");
  }
  writeFileSync("data/lab/radar-as-measured.json", JSON.stringify({ measuredAt: MEASURED_AT, note: "Radar scored with the rules as of the recorded run, on the values recorded at run time.", views }));
  console.log(`radar-as-measured.json: ${views.length} views (rules from ${MEASURED_AT})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
