// SignClear Fraud Lab — evaluation runner. Runs the REAL quarantined reader (readDocumentLive) on every
// case of a corpus, then the rules exactly as production runs them (src/lib/lab/evaluate.ts), and records
// what the money guardians would have done.
//
//   node --use-system-ca --env-file=.env --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/lab/run.mts \
//        [--corpus dev|unseen] [--model claude-haiku-5-5] [--condition pdf|scan|photo] [--limit N] [--scheme X]
//        [--oracle] [--fresh] [--cached-only] [--budget 6] [--concurrency 4] [--no-db]
//
// --corpus   dev = v1 corpus (rules-extra was written alongside it); unseen = v2 held-out set (frozen; the
//            runner verifies data/lab/unseen.lock.json and refuses to run if any file changed)
// --oracle   no API calls: uses the ground-truth values (checks labels + rules only)
// --fresh    ignore cached reads (by default an identical input that was already read is re-scored, not re-bought)
// Every new dollar spent is appended to data/lab/spend.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import type { LabCorpus, LabCaseResult } from "../../src/lib/lab/types.ts";

const argv = process.argv.slice(2);
const arg = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (k: string) => argv.includes(`--${k}`);
const ORACLE = flag("oracle");
const corpusName = (arg("corpus") ?? "dev") as "dev" | "unseen";
const model = ORACLE ? "oracle" : (arg("model") ?? process.env.READER_MODEL ?? "claude-opus-5-5");
if (!ORACLE) process.env.READER_MODEL = model; // reader.ts reads it at import time
const limit = Number(arg("limit") ?? Infinity);
const budget = Number(arg("budget") ?? 6);
const concurrency = Number(arg("concurrency") ?? 4);

const { readDocumentLive, toValues, accuracy } = await import("../../src/lib/reader.ts");
const { evaluateCase, outcomeFor, withReason } = await import("../../src/lib/lab/evaluate.ts");
const { summarize, costOf } = await import("../../src/lib/lab/metrics.ts");

const corpusFile = corpusName === "unseen" ? "data/lab/unseen.json" : "data/lab/corpus.json";
const raw = readFileSync(corpusFile);
if (corpusName === "unseen") {
  const lock = JSON.parse(readFileSync("data/lab/unseen.lock.json", "utf8")) as { corpusSha256: string; docs: Record<string, string> };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  if (sha(raw) !== lock.corpusSha256) throw new Error("unseen.json changed after it was frozen (unseen.lock.json). Refusing to run.");
  for (const [doc, h] of Object.entries(lock.docs)) if (sha(readFileSync(`public${doc}`)) !== h) throw new Error(`${doc} changed after the unseen set was frozen. Refusing to run.`);
  console.log(`unseen set verified against unseen.lock.json (${Object.keys(lock.docs).length} documents)`);
}
const corpus = JSON.parse(raw.toString("utf8")) as LabCorpus;
let cases = corpus.cases;
if (arg("condition")) cases = cases.filter((c) => (c.condition ?? "pdf") === arg("condition"));
if (arg("scheme")) cases = cases.filter((c) => c.scheme === arg("scheme"));
cases = cases.slice(0, limit);

type Read = { rows: { label: string; value: string }[]; latencyMs: number; tokensIn: number; tokensOut: number };
// dev keeps its historical cache name: the v1 PDFs are byte-identical, so earlier reads are reused as-is.
const cacheFile = corpusName === "unseen" ? `data/lab/reads-${model}-unseen.json` : `data/lab/reads-${model}.json`;
const cache: Record<string, Read> = !ORACLE && !flag("fresh") && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
// --cached-only: re-score only inputs that were already read (no new spend); the run is marked partial.
if (flag("cached-only")) cases = cases.filter((c) => cache[c.key]);
const saveCache = () => !ORACLE && writeFileSync(cacheFile, JSON.stringify(cache));

const startedAt = new Date();
let spent = 0;
let reused = 0;
let stopped = false;
const results: LabCaseResult[] = [];

async function readCase(key: string, doc: string, mediaType: string): Promise<Read> {
  if (cache[key]) {
    reused++;
    return cache[key];
  }
  const base64 = readFileSync(`public${doc}`).toString("base64");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await readDocumentLive({ base64, mediaType }, AbortSignal.timeout(180_000));
      const u = r.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
      const read: Read = { rows: r.rows, latencyMs: r.latencyMs, tokensIn: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), tokensOut: u.output_tokens };
      cache[key] = read;
      spent += costOf(model, read.tokensIn, read.tokensOut);
      return read;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

let next = 0;
async function worker() {
  while (next < cases.length && !stopped) {
    const c = cases[next++];
    if (!ORACLE && !cache[c.key] && spent > budget) {
      stopped = true;
      console.log(`budget $${budget} reached ($${spent.toFixed(2)}); stopping`);
      break;
    }
    const truth = { ...c.truth } as Record<string, unknown>;
    delete truth.sums_ok;
    let read: Read | null = null;
    let error: string | undefined;
    try {
      read = ORACLE ? { rows: [], latencyMs: 0, tokensIn: 0, tokensOut: 0 } : await readCase(c.key, c.doc ?? c.pdf, c.mediaType ?? "application/pdf");
    } catch (e) {
      error = String(e).slice(0, 200);
    }
    const values = ORACLE ? { ...c.truth } : read ? toValues(read.rows) : {};
    let ev = evaluateCase(c, values, c.preparerKey); // preparerKey = the PTIN registered with SignClear
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
    results.push({
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
      costUsd: read ? costOf(model, read.tokensIn, read.tokensOut) : 0,
      values: ev.values,
    });
    const r = results[results.length - 1];
    console.log(`${String(results.length).padStart(3)}/${cases.length} ${c.key.padEnd(34)} ${r.production.verdict.padEnd(18)} core:${r.core.verdict.padEnd(18)} reader ${acc.ok}/${acc.total} ${r.error ? "ERR " + r.error.slice(0, 60) : ""} $${spent.toFixed(2)}`);
    if (results.length % 5 === 0) saveCache();
  }
}
await Promise.all(Array.from({ length: ORACLE ? 1 : concurrency }, worker));
saveCache();
const finishedAt = new Date();
const order = new Map(cases.map((c, i) => [c.key, i]));
results.sort((a, b) => order.get(a.caseKey)! - order.get(b.caseKey)!);
const summary = summarize(results);
const meta = {
  model,
  corpus: corpusName,
  labVersion: 2,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  cases: results.length,
  readsReused: reused,
  newSpendUsd: Number(spent.toFixed(4)),
  partial: stopped || results.length < corpus.cases.length,
  filters: { condition: arg("condition") ?? null, scheme: arg("scheme") ?? null, limit: Number.isFinite(limit) ? limit : null },
};
mkdirSync("data/lab", { recursive: true });
const outFile = `data/lab/results-${model}-${corpusName}.json`;
writeFileSync(outFile, JSON.stringify({ run: { ...meta, summary }, results }, null, 1));
if (!ORACLE && spent > 0) {
  const ledger = existsSync("data/lab/spend.json") ? (JSON.parse(readFileSync("data/lab/spend.json", "utf8")) as unknown[]) : [];
  ledger.push({ at: finishedAt.toISOString(), model, corpus: corpusName, newReads: results.length - reused, usd: Number(spent.toFixed(4)) });
  writeFileSync("data/lab/spend.json", JSON.stringify(ledger, null, 1));
}

if (!flag("no-db") && !ORACLE) {
  const { storeRun } = await import("./store.mts");
  const id = await storeRun({ ...meta, summary }, results);
  console.log(`stored LabRun ${id}`);
}

console.log(`\n${outFile}`);
const line = (name: string, s: (typeof summary)["production"]["all"]) =>
  console.log(`${name.padEnd(22)} fraud stopped ${s.fraud.detected}/${s.fraud.n} (${(s.fraud.rate * 100).toFixed(1)}%, right reason ${s.fraud.rightReason}) · warned-only ${s.fraud.warnedOnly} · clean FP ${s.clean.falsePositives}/${s.clean.n} · money moved wrongly ${s.moneyMovedWrongly} · injection ${s.injection.detected}/${s.injection.n} · reader ${s.reader.ok}/${s.reader.total} (${(s.reader.rate * 100).toFixed(1)}%)`);
line("production · all", summary.production.all);
for (const [c, m] of Object.entries(summary.production.byCondition)) line(`production · ${c}`, m!);
line("core R1–R12 · all", summary.core.all);
if (summary.paired.returns) console.log(`verdict changes across conditions: ${summary.paired.verdictFlips}/${summary.paired.returns} returns`);
console.log(`reads cost $${summary.production.all.costUsd.toFixed(2)} (this run spent $${spent.toFixed(2)} new, reused ${reused}) · p50 ${summary.production.all.latency.p50} ms`);
