// Server-only loaders for the Fraud Lab (corpus files + stored runs) and the radar evaluation.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Condition, LabCase, LabCorpus, LabCaseResult, LabPreparer, Scheme, ScoreMode, Split } from "./types";
import { summarize, type RunSummary } from "./metrics";
import { scoreRadar, toRadarCase, HOLD_THRESHOLD, type RadarCase, type RadarResult } from "../radar";
import type { Values } from "../rules";

const DIR = path.join(process.cwd(), "data", "lab");

const cache: Partial<Record<Split, LabCorpus>> = {};
/** dev = corpus v1 (data/lab/corpus.json); unseen = corpus v2 held-out set (data/lab/unseen.json). */
export function loadCorpus(name: Split = "dev"): LabCorpus {
  if (!cache[name]) {
    const f = path.join(DIR, name === "unseen" ? "unseen.json" : "corpus.json");
    cache[name] = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as LabCorpus) : { version: 0, generatedAt: "", note: "", seed: 0, preparers: [], cases: [] };
  }
  return cache[name]!;
}
export function allCases(): LabCase[] {
  return [...loadCorpus("dev").cases, ...loadCorpus("unseen").cases];
}
export function allPreparers(): LabPreparer[] {
  return [...loadCorpus("dev").preparers, ...loadCorpus("unseen").preparers];
}

export type LabRunView = { id: string; model: string; corpus: Split; label: string; startedAt: string; finishedAt: string | null; cases: number; partial: boolean; summary: RunSummary; results: LabCaseResult[] };

type Detail = Pick<LabCaseResult, "production" | "core" | "readerMisses" | "costUsd" | "error" | "preparerKey" | "baseKey" | "values">;

/** Latest stored v2 run per (model, corpus) from the DB; falls back to data/lab/results-*.json. */
export async function loadRuns(): Promise<LabRunView[]> {
  try {
    const { db } = await import("../db");
    const runs = await db.labRun.findMany({ where: { version: 2 }, orderBy: { startedAt: "desc" }, include: { results: true } });
    const seen = new Set<string>();
    const out: LabRunView[] = [];
    for (const r of runs) {
      const k = `${r.model}|${r.corpus}`;
      if (seen.has(k) || !r.results.length) continue;
      seen.add(k);
      const results: LabCaseResult[] = r.results.map((x) => {
        const d = JSON.parse(x.detail) as Detail;
        return {
          caseKey: x.caseKey,
          baseKey: d.baseKey,
          scheme: x.scheme as Scheme,
          split: x.split as Split,
          condition: x.condition as Condition,
          expected: x.expected,
          preparerKey: d.preparerKey,
          error: d.error,
          production: d.production,
          core: d.core,
          readerOk: x.readerOk,
          readerTotal: x.readerTotal,
          readerMisses: d.readerMisses ?? [],
          latencyMs: x.latencyMs,
          tokensIn: x.tokensIn,
          tokensOut: x.tokensOut,
          costUsd: d.costUsd ?? 0,
          values: d.values,
        };
      });
      const meta = (JSON.parse(r.summary) as { meta?: { partial?: boolean } }).meta;
      out.push({ id: r.id, model: r.model, corpus: r.corpus as Split, label: r.label, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, cases: results.length, partial: !!meta?.partial, summary: summarize(results), results });
    }
    if (out.length) return out;
  } catch {
    /* fall back to files */
  }
  return loadRunFiles();
}

/** Stored runs from files. prefix "results" = as measured (rules frozen at run time);
 *  "rescored" = the same cached reads re-scored with today's rules by scripts/lab/rescore.mts (no new model calls). */
export function loadRunFiles(includeOracle = false, prefix: "results" | "rescored" = "results"): LabRunView[] {
  if (!existsSync(DIR)) return [];
  const re = new RegExp(`^${prefix}-.*\\.json$`);
  return readdirSync(DIR)
    .filter((f) => re.test(f) && (includeOracle || !f.includes("oracle")))
    .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as { run: { model: string; corpus?: Split; labVersion?: number; startedAt: string; finishedAt: string; partial?: boolean }; results: LabCaseResult[] })
    .filter((j) => j.run.labVersion === 2)
    .map((j) => ({ id: `${prefix}-${j.run.model}-${j.run.corpus}`, model: j.run.model, corpus: j.run.corpus ?? "dev", label: j.run.corpus ?? "dev", startedAt: j.run.startedAt, finishedAt: j.run.finishedAt, cases: j.results.length, partial: !!j.run.partial, summary: summarize(j.results), results: j.results }));
}

// ------------------------------------------------------------------ radar over what the READER extracted
export type RadarSource = { id: string; corpus: Split; model: string; condition: Condition | "truth"; label: string };
export type RadarEval = { holdTP: number; holdFP: number; bad: number; honest: number; precision: number; recall: number; watchOrHoldTP: number; watchOrHoldFP: number; honestFlagged: string[]; badMissed: string[] };

/** The population as the radar would see it: pre-filing returns, values = what the reader extracted from
 *  the given condition (or ground truth for the "truth" baseline). Unread/failed cases are left out. */
export function radarPopulation(corpus: Split, values: (c: LabCase) => Values | null, condition: Condition | "truth"): RadarCase[] {
  const c = loadCorpus(corpus);
  const name = Object.fromEntries(c.preparers.map((p) => [p.key, `${p.name} · ${p.firm}`]));
  const out: RadarCase[] = [];
  for (const x of c.cases) {
    if (x.scheme.startsWith("post_")) continue;
    if (condition !== "truth" && (x.condition ?? "pdf") !== condition) continue;
    if (condition === "truth" && (x.condition ?? "pdf") !== "pdf") continue;
    const v = values(x);
    if (!v) continue;
    out.push(toRadarCase({ caseKey: x.baseKey ?? x.key, preparerKey: x.preparerKey, preparerName: name[x.preparerKey], intake: x.intake, values: v }));
  }
  return out;
}

export function radarEval(r: RadarResult, preparers: LabPreparer[]): RadarEval {
  const bad = new Set(preparers.filter((p) => p.bad).map((p) => p.key));
  const inPop = r.preparers.map((p) => p.preparerKey);
  const held = r.preparers.filter((p) => p.hold);
  const flagged = r.preparers.filter((p) => p.level !== "LOW");
  const tp = held.filter((p) => bad.has(p.preparerKey)).length;
  const nBad = inPop.filter((k) => bad.has(k)).length;
  return {
    holdTP: tp,
    holdFP: held.length - tp,
    bad: nBad,
    honest: inPop.length - nBad,
    precision: held.length ? tp / held.length : 1,
    recall: nBad ? tp / nBad : 1,
    watchOrHoldTP: flagged.filter((p) => bad.has(p.preparerKey)).length,
    watchOrHoldFP: flagged.filter((p) => !bad.has(p.preparerKey)).length,
    honestFlagged: flagged.filter((p) => !bad.has(p.preparerKey)).map((p) => `${p.preparerKey} (${p.level})`),
    badMissed: inPop.filter((k) => bad.has(k) && !held.some((p) => p.preparerKey === k)),
  };
}

export type RadarView = RadarSource & { result: RadarResult; eval: RadarEval; cases: number };

/** Lab runs for a scoring mode: "measured" = recorded runs (DB, else files); "current" = re-scored files. */
export async function loadRunsFor(mode: ScoreMode): Promise<LabRunView[]> {
  return mode === "current" ? loadRunFiles(false, "rescored") : loadRuns();
}

/** Every radar configuration: ground truth + each stored run × condition.
 *  "measured": frozen at the recorded run (rules as of MEASURED_AT, values recorded then) — data/lab/radar-as-measured.json.
 *  "current": today's radar + rules on the re-scored values (same cached reads). */
export async function radarViews(mode: ScoreMode = "current"): Promise<RadarView[]> {
  if (mode === "measured") {
    const f = path.join(DIR, "radar-as-measured.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { views: RadarView[] }).views : [];
  }
  const runs = loadRunFiles(false, "rescored");
  const out: RadarView[] = [];
  for (const corpus of ["unseen", "dev"] as Split[]) {
    const c = loadCorpus(corpus);
    if (!c.cases.length) continue;
    const push = (model: string, condition: Condition | "truth", values: (x: LabCase) => Values | null, label: string) => {
      const pop = radarPopulation(corpus, values, condition);
      if (!pop.length) return;
      const result = scoreRadar(pop);
      out.push({ id: `${corpus}|${model}|${condition}`, corpus, model, condition, label, result, eval: radarEval(result, c.preparers), cases: pop.length });
    };
    for (const run of runs.filter((r) => r.corpus === corpus)) {
      const byKey = new Map(run.results.map((r) => [r.caseKey, r]));
      const conds = [...new Set(run.results.map((r) => r.condition ?? "pdf"))];
      for (const cond of conds) push(run.model, cond, (x) => { const r = byKey.get(x.key); return r && !r.error && r.values ? r.values : null; }, `${run.model} · ${cond}`);
    }
    push("truth", "truth", (x) => x.truth, "ground-truth values (no reader)");
  }
  return out;
}

export const RADAR_HOLD = HOLD_THRESHOLD;
