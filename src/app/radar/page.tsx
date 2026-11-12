import type { Metadata } from "next";
import { allPreparers, loadCorpus, radarViews } from "@/lib/lab/data";
import { HOLD_THRESHOLD, WATCH_THRESHOLD } from "@/lib/radar";
import { MEASURED_AT, isPost, type ScoreMode } from "@/lib/lab/types";
import { LabNav, ModeSwitch } from "../lab/LabNav";
import { RadarClient, type ViewData } from "./RadarClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "SignClear — Ghost-Preparer Radar", description: "Cross-case analysis that scores preparers by the patterns their clients' returns share, computed from what the reader extracted." };

const ORDER = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "truth"];
const CORDER = ["photo", "scan", "pdf", "truth"];

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ rules?: string }> }) {
  const mode: ScoreMode = (await searchParams).rules === "measured" ? "measured" : "current";
  const meta = Object.fromEntries(allPreparers().map((p) => [p.key, p]));
  const views = (await radarViews(mode)).sort(
    (a, b) => (a.corpus === b.corpus ? 0 : a.corpus === "unseen" ? -1 : 1) || ORDER.indexOf(a.model) - ORDER.indexOf(b.model) || CORDER.indexOf(a.condition) - CORDER.indexOf(b.condition),
  );
  const data: ViewData[] = views.map((v) => ({
    id: v.id,
    corpus: v.corpus,
    model: v.model,
    condition: v.condition,
    cases: v.cases,
    eval: v.eval,
    links: v.result.links,
    population: v.result.population,
    preparers: v.result.preparers.map((p) => ({ ...p, kind: meta[p.preparerKey]?.kind ?? "human", truthBad: !!meta[p.preparerKey]?.bad, note: meta[p.preparerKey]?.note ?? "" })),
  }));
  // Population sizes, so the radar's count can be reconciled with the Fraud Lab's.
  const totals = Object.fromEntries(
    (["unseen", "dev"] as const).map((c) => {
      const pdf = loadCorpus(c).cases.filter((x) => (x.condition ?? "pdf") === "pdf");
      return [c, { returns: pdf.length, preFiling: pdf.filter((x) => !isPost(x.scheme)).length, postFiling: pdf.filter((x) => isPost(x.scheme)).length }];
    }),
  ) as ViewTotals;
  const def = data.find((v) => v.corpus === "unseen" && v.model === "claude-opus-5-5" && v.condition === "photo") ?? data.find((v) => v.corpus === "unseen") ?? data[0];
  return (
    <main className="min-h-screen pb-20">
      <LabNav active="radar" />
      <ModeSwitch mode={mode} base="/radar" measuredAt={MEASURED_AT} />
      <RadarClient key={mode} mode={mode} views={data} defaultId={def?.id ?? ""} thresholds={{ hold: HOLD_THRESHOLD, watch: WATCH_THRESHOLD }} totals={totals} />
    </main>
  );
}

type ViewTotals = Record<"unseen" | "dev", { returns: number; preFiling: number; postFiling: number }>;
