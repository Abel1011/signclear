import type { Metadata } from "next";
import { allCases, allPreparers, loadCorpus, loadRunFiles, loadRuns, loadRunsFor } from "@/lib/lab/data";
import { MEASURED_AT, SCHEME_LABEL, isFraud, isPost, type ScoreMode } from "@/lib/lab/types";
import { LabNav, ModeSwitch } from "./LabNav";
import { LabClient, type CaseRow, type Compare, type RunCard } from "./LabClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "SignClear — Fraud Lab", description: "Measured protection: synthetic ghost-preparer frauds run through the real reader and the production rules, on clean PDFs, scans and phone photos." };

const ORDER = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export default async function LabPage({ searchParams }: { searchParams: Promise<{ rules?: string }> }) {
  const mode: ScoreMode = (await searchParams).rules === "measured" ? "measured" : "current";
  const dev = loadCorpus("dev");
  const unseen = loadCorpus("unseen");
  const runs = await loadRunsFor(mode);
  // Side-by-side headline: the recorded measurement vs the same reads re-scored with today's rules.
  const measuredUnseen = (await loadRuns()).filter((r) => r.corpus === "unseen");
  const currentUnseen = loadRunFiles(false, "rescored").filter((r) => r.corpus === "unseen");
  const compare: Compare[] = ORDER.flatMap((model) => {
    const a = measuredUnseen.find((r) => r.model === model);
    const b = currentUnseen.find((r) => r.model === model);
    return a && b ? [{ model, measured: a.summary.production.all, current: b.summary.production.all }] : [];
  });
  const cases = new Map(allCases().map((c) => [c.key, c]));
  const prep = Object.fromEntries(allPreparers().map((p) => [p.key, p]));
  runs.sort((a, b) => (a.corpus === b.corpus ? 0 : a.corpus === "unseen" ? -1 : 1) || ORDER.indexOf(a.model) - ORDER.indexOf(b.model));
  const cards: RunCard[] = runs.map((r) => ({ id: r.id, model: r.model, corpus: r.corpus, partial: r.partial, cases: r.cases, startedAt: r.startedAt, summary: r.summary }));
  const caseRowsByRun: Record<string, CaseRow[]> = {};
  for (const r of runs) {
    caseRowsByRun[r.id] = r.results.flatMap((x) => {
      const c = cases.get(x.caseKey);
      if (!c) return [];
      const p = prep[c.preparerKey];
      return [
        {
          key: c.key,
          scheme: c.scheme,
          schemeLabel: SCHEME_LABEL[c.scheme],
          variant: c.variant,
          condition: x.condition ?? "pdf",
          description: c.description,
          preparer: `${p.name} · ${p.firm}`,
          preparerKey: c.preparerKey,
          preparerBad: p.bad,
          clientName: c.intake.name,
          fraud: isFraud(c.scheme),
          expected: c.expected,
          doc: c.doc ?? c.pdf,
          pdf: c.pdf,
          injection: c.injection ? `${c.injection.technique}: ${c.injection.text}` : undefined,
          production: x.production,
          core: x.core,
          readerOk: x.readerOk,
          readerTotal: x.readerTotal,
          readerMisses: x.readerMisses,
          latencyMs: x.latencyMs,
          costUsd: x.costUsd,
          error: x.error,
        },
      ];
    });
  }
  const pdfUnseen = unseen.cases.filter((c) => (c.condition ?? "pdf") === "pdf");
  const counts = {
    dev: { cases: dev.cases.length, fraud: dev.cases.filter((c) => isFraud(c.scheme)).length },
    unseen: {
      returns: pdfUnseen.length,
      preFiling: pdfUnseen.filter((c) => !isPost(c.scheme)).length,
      postFiling: pdfUnseen.filter((c) => isPost(c.scheme)).length,
      honestPre: pdfUnseen.filter((c) => c.scheme === "clean").length,
      honestPost: pdfUnseen.filter((c) => c.scheme === "post_clean").length,
      docs: unseen.cases.length,
      fraud: pdfUnseen.filter((c) => isFraud(c.scheme)).length,
      preparers: unseen.preparers.length,
    },
    schemes: new Set(dev.cases.map((c) => c.scheme)).size - 2,
  };
  // Perfect-reader reference (ground-truth values through the same rules): what the rules alone get right.
  const oracleRun = loadRunFiles(true, mode === "current" ? "rescored" : "results").find((r) => r.model === "oracle" && r.corpus === "unseen");
  const oracle = oracleRun?.summary.production.byCondition.pdf ?? null;
  const liveKeys = [...unseen.cases, ...dev.cases].map((c) => ({ key: c.key, doc: c.doc ?? c.pdf }));
  return (
    <main className="min-h-screen pb-20">
      <LabNav active="lab" />
      <ModeSwitch mode={mode} base="/lab" measuredAt={MEASURED_AT} />
      <LabClient key={mode} mode={mode} runs={cards} caseRowsByRun={caseRowsByRun} counts={counts} liveKeys={liveKeys} oracle={oracle} compare={compare} />
    </main>
  );
}
