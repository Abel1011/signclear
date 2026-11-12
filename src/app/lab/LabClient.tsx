"use client";
import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { registerAgGrid, fcTheme } from "@/components/agGrid";
import type { RunSummary, Metrics } from "@/lib/lab/metrics";
import { CONDITION_LABEL, SCHEME_LABEL, type Condition, type Scheme, type Split, type VariantOutcome } from "@/lib/lab/types";
import { Big } from "./LabNav";

registerAgGrid();

export type RunCard = { id: string; model: string; corpus: Split; partial: boolean; cases: number; startedAt: string; summary: RunSummary };
export type CaseRow = {
  key: string;
  scheme: Scheme;
  schemeLabel: string;
  variant: string;
  condition: Condition;
  description: string;
  preparer: string;
  preparerKey: string;
  preparerBad: boolean;
  clientName: string;
  fraud: boolean;
  expected: string;
  doc: string;
  pdf: string;
  injection?: string;
  production: VariantOutcome;
  core: VariantOutcome;
  readerOk: number;
  readerTotal: number;
  readerMisses: { k: string; read: unknown; truth: unknown }[];
  latencyMs: number;
  costUsd: number;
  error?: string;
};
type CondView = Condition | "all";
type Live = { loading?: boolean; error?: string; data?: { model: string; condition: Condition; latencyMs: number; costUsd: number; reader: { ok: number; total: number }; production: VariantOutcome; core: VariantOutcome } };
type Counts = {
  dev: { cases: number; fraud: number };
  unseen: { returns: number; preFiling: number; postFiling: number; honestPre: number; honestPost: number; docs: number; fraud: number; preparers: number };
  schemes: number;
};
export type Compare = { model: string; measured: Metrics; current: Metrics };
type Mode = "measured" | "current";
const RULE_NAME: Record<string, string> = {
  R1: "preparer section blank / not signed",
  R2: "PTIN missing or not this preparer's",
  R3: "refund account isn't the one the client gave",
  R4: "Schedule C doesn't match the interview",
  X3: "Schedule C loss vs. what the client said",
  R5: "more dependents than the client named",
  R8: "taxpayer name doesn't match",
};

const pct = (x: number) => `${(x * 100).toFixed(x === 1 || x === 0 ? 0 : 1)}%`;
const usd = (x: number) => `$${x.toFixed(x < 1 ? 3 : 2)}`;
/** "claude-sonnet-5-5" -> "Sonnet 5.5" */
export const modelName = (m: string) => m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());
const corpusName = (c: Split) => (c === "unseen" ? "Unseen held-out set" : "Dev corpus v1");
const CONDS: Condition[] = ["pdf", "scan", "photo"];
const COND_SHORT: Record<Condition, string> = { pdf: "Clean PDF", scan: "Scan", photo: "Phone photo" };

const outcomeLabel = (o: VariantOutcome, fraud: boolean) =>
  o.moneyMovedWrongly && !fraud
    ? "honest fee refund proposed"
    : o.verdict === "READ_FAILED"
      ? "held"
      : fraud
        ? o.detected
          ? "stopped"
          : o.warnedOnly
            ? "warned"
            : "missed"
        : o.detected
          ? "honest · blocked"
          : o.verdict === "CLARIFY"
            ? "honest · asked to clarify"
            : "passed";

function Stamp({ o, fraud }: { o: VariantOutcome; fraud: boolean }) {
  const wrong = o.moneyMovedWrongly;
  const label = outcomeLabel(o, fraud);
  const cls = wrong ? "text-diff" : !fraud && (o.detected || o.verdict === "CLARIFY") ? "text-ask" : fraud && !o.detected ? "text-ask" : "text-ok";
  return <span className={`stamp text-[10px] ${cls}`}>{label}</span>;
}

const metricsOf = (r: RunCard | undefined, c: CondView): Metrics | undefined => (r ? (c === "all" ? r.summary.production.all : r.summary.production.byCondition[c]) : undefined);

export function LabClient({
  mode,
  runs,
  caseRowsByRun,
  counts,
  liveKeys,
  oracle,
  compare,
}: {
  mode: Mode;
  runs: RunCard[];
  caseRowsByRun: Record<string, CaseRow[]>;
  counts: Counts;
  liveKeys: { key: string; doc: string }[];
  oracle: Metrics | null;
  compare: Compare[];
}) {
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const run = runs.find((r) => r.id === runId);
  const [cond, setCond] = useState<CondView>("all");
  const [sel, setSel] = useState<CaseRow | null>(null);
  const [live, setLive] = useState<Live>({});
  const [liveKey, setLiveKey] = useState(liveKeys.find((c) => c.key.includes("injection") && c.key.endsWith(".photo"))?.key ?? liveKeys[0]?.key);
  const conds = run ? CONDS.filter((c) => run.summary.production.byCondition[c]) : [];
  const view: CondView = cond !== "all" && !conds.includes(cond) ? "all" : cond;
  const m = metricsOf(run, view);
  const core = run ? (view === "all" ? run.summary.core.all : run.summary.core.byCondition[view]) : undefined;
  const rows = useMemo(() => (caseRowsByRun[runId] ?? []).filter((r) => view === "all" || r.condition === view), [caseRowsByRun, runId, view]);
  const unseenRuns = runs.filter((r) => r.corpus === "unseen");
  const devRuns = runs.filter((r) => r.corpus === "dev");

  const schemeRows = useMemo(
    () =>
      m
        ? (Object.entries(m.perScheme) as [Scheme, NonNullable<Metrics["perScheme"][Scheme]>][])
            .map(([s, v]) => ({ scheme: SCHEME_LABEL[s], kind: s === "clean" || s === "post_clean" ? "control" : "fraud", n: v.n, detected: v.detected, rate: v.rate, warnedOnly: v.warnedOnly, moneyMovedWrongly: v.moneyMovedWrongly }))
            .sort((a, b) => (a.kind === b.kind ? a.rate - b.rate : a.kind === "fraud" ? -1 : 1))
        : [],
    [m],
  );

  const schemeCols = useMemo<ColDef[]>(
    () => [
      { field: "scheme", headerName: "Scheme", flex: 2, minWidth: 230, tooltipField: "scheme" },
      { field: "kind", headerName: "Type", width: 95, filter: true },
      { field: "n", headerName: "Docs", width: 80, type: "numericColumn" },
      { field: "detected", headerName: "Stopped", width: 96, type: "numericColumn", headerTooltip: "Fraud: blocked before PayPal authorization (or refund proposed after filing). Honest control: approval blocked until the preparer fixes it (or, after filing, an honest fee refund proposed)." },
      {
        field: "rate",
        headerName: "Rate",
        flex: 1,
        minWidth: 140,
        cellRenderer: (p: ICellRendererParams) => (
          <div className="flex items-center gap-2">
            <div className="h-2.5 flex-1 rounded-sm border border-ink/30 bg-sheet">
              <div className={`h-full ${p.data.kind === "control" ? "bg-ask" : "bg-ink"}`} style={{ width: `${p.value * 100}%` }} />
            </div>
            <span className="w-12 text-right font-mono text-[12px]">{pct(p.value)}</span>
          </div>
        ),
      },
      { field: "warnedOnly", headerName: "Warned", width: 92, type: "numericColumn", headerTooltip: "Only a CLARIFY warning: the client must explicitly accept it before money can move." },
      { field: "moneyMovedWrongly", headerName: "Money wrong", width: 115, headerTooltip: "Money moved wrongly", type: "numericColumn", cellClass: (p) => (p.value ? "text-diff font-bold" : "") },
    ],
    [],
  );

  const caseCols = useMemo<ColDef<CaseRow>[]>(
    () => [
      { field: "key", headerName: "Document", width: 230, pinned: "left", cellClass: "font-mono text-[12px]" },
      { field: "condition", headerName: "Condition", width: 115, filter: "agSetColumnFilter", valueFormatter: (p) => COND_SHORT[p.value as Condition] ?? p.value },
      { field: "schemeLabel", headerName: "Scheme", width: 230, filter: "agSetColumnFilter" },
      { field: "variant", headerName: "Variant", width: 220, filter: "agSetColumnFilter" },
      { headerName: "Verdict", width: 175, valueGetter: (p) => p.data?.production.verdict, filter: "agSetColumnFilter" },
      { headerName: "Outcome", width: 190, valueGetter: (p) => (p.data ? outcomeLabel(p.data.production, p.data.fraud) : ""), filter: "agSetColumnFilter", cellRenderer: (p: ICellRendererParams<CaseRow>) => (p.data ? <Stamp o={p.data.production} fraud={p.data.fraud} /> : null) },
      { headerName: "Rules fired", flex: 1, minWidth: 220, valueGetter: (p) => p.data?.production.rules.join(" · ") || "—", cellClass: "font-mono text-[12px]" },
      { headerName: "Reader", width: 105, valueGetter: (p) => (p.data ? `${p.data.readerOk}/${p.data.readerTotal}` : ""), cellClass: (p) => (p.data && p.data.readerOk < p.data.readerTotal ? "text-diff font-mono" : "font-mono") },
      { field: "latencyMs", headerName: "Latency", width: 110, type: "numericColumn", valueFormatter: (p) => `${(p.value / 1000).toFixed(1)} s` },
      { field: "preparer", headerName: "Preparer", width: 260, filter: "agSetColumnFilter" },
    ],
    [],
  );

  const tryLive = async () => {
    setLive({ loading: true });
    try {
      const r = await fetch("/api/lab/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseKey: liveKey }) });
      const j = await r.json();
      setLive(r.ok ? { data: j } : { error: j.error ?? `HTTP ${r.status}` });
    } catch (e) {
      setLive({ error: String(e) });
    }
  };

  if (!run || !m)
    return (
      <section className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6">
        <div className="card p-6">No lab run stored yet. Run <code className="font-mono">scripts/lab/run.mts</code> or import with <code className="font-mono">scripts/lab/import.mts</code>.</div>
      </section>
    );

  // Facts for the "how to read" box, computed from the stored runs (never typed by hand).
  const u = (model: string, c: Condition) => unseenRuns.find((r) => r.model === model)?.summary.production.byCondition[c];
  const readerRange = (c: Condition) => {
    const xs = unseenRuns.map((r) => r.summary.production.byCondition[c]?.reader.rate).filter((x): x is number => x !== undefined);
    return xs.length ? `${pct(Math.min(...xs))}–${pct(Math.max(...xs))}` : "—";
  };
  const devSame = devRuns.length > 1 && new Set(devRuns.map((r) => `${r.summary.production.all.fraud.detected}/${r.summary.production.all.clean.falsePositives}`)).size === 1;

  return (
    <section className="mx-auto max-w-[1280px] px-4 sm:px-6">
      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-end">
        <div>
          <div className="eyebrow">
            Fraud Lab · synthetic TY2025 returns · {counts.schemes} fraud schemes · production rules only
          </div>
          <h1 className="mt-2 font-display text-[40px] leading-[1.04] sm:text-[54px]">
            We attacked our own client. <em className="hl">Here is what held up, and what didn&apos;t.</em>
          </h1>
          <p className="mt-3 max-w-[66ch] text-[15px] leading-relaxed text-ink-soft">
            Headline numbers come from an <b>unseen held-out set</b>: {counts.unseen.returns} returns ({counts.unseen.fraud} with a fraud) by {counts.unseen.preparers} new preparers, generated after the rules were frozen — <b>{counts.unseen.preFiling} pre-filing returns</b> (checked before the client signs) and <b>{counts.unseen.postFiling} post-filing cases</b> (IRS transcript vs. the deposit the client got). Each was sent to the real quarantined reader as a <b>clean PDF, a scan and a phone photo</b> ({counts.unseen.docs} documents). The reader extracts values; deterministic rules decide; we record whether PayPal would have moved the money.{" "}
            {mode === "measured" ? (
              <>Shown here: the rules <b>as they were when the set was run</b>.</>
            ) : (
              <>
                Shown here: the <b className="text-ask">same reads re-scored with today&apos;s rules</b> — the rules were fixed after seeing these results, so this view is <b>not</b> an unseen test.
              </>
            )}
          </p>
        </div>
        <div className="card flex flex-col gap-3 p-4">
          <div className="eyebrow">Run</div>
          <div className="flex flex-wrap gap-2">
            {runs.map((r) => (
              <button key={r.id} className={`chip ${r.id === runId ? "chip-on" : ""}`} onClick={() => setRunId(r.id)}>
                <span>{modelName(r.model)}</span>
                <span className="opacity-70">&nbsp;·&nbsp;{r.corpus === "unseen" ? "unseen" : "dev v1"}</span>
                {r.partial && <span className="opacity-70">&nbsp;(partial)</span>}
              </button>
            ))}
          </div>
          {conds.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {(["all", ...conds] as CondView[]).map((c) => (
                <button key={c} className={`chip ${c === view ? "chip-on" : ""}`} onClick={() => setCond(c)}>
                  {c === "all" ? "All conditions" : COND_SHORT[c]}
                </button>
              ))}
            </div>
          )}
          <p className="text-[12px] leading-snug text-ink-soft">
            {corpusName(run.corpus)} · {modelName(run.model)} reader · {view === "all" ? "all document conditions" : CONDITION_LABEL[view]}
          </p>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Big label="Frauds stopped before money moved" value={pct(m.fraud.rate)} sub={`${m.fraud.detected} of ${m.fraud.n} fraud documents · ${m.fraud.rightReason} for the right reason (a rule that also fires on the true values) · ${m.fraud.warnedOnly} more only warned`} tone="ok" />
        <Big label="Money moved wrongly" value={String(m.moneyMovedWrongly)} sub={m.moneyMovedWrongly ? "fraud reached a silent MATCH (or the fee stood after a diversion), or an honest fee would be refunded" : "no fraud reached a silent MATCH; no honest fee refunded"} tone={m.moneyMovedWrongly ? "diff" : "ok"} />
        <Big
          label="Honest returns: approval blocked"
          value={`${m.clean.blocked}/${m.clean.preN}`}
          sub={
            <>
              {pct(m.clean.preN ? m.clean.blocked / m.clean.preN : 0)} of honest pre-filing documents; the preparer fixes and re-uploads, no money lost. {m.clean.clarified} more only <b>asked the client to clarify</b> (no block).
              {m.clean.postN > 0 && ` After filing: ${m.clean.refundProposed}/${m.clean.postN} honest fees proposed for refund.`}
            </>
          }
          tone={m.clean.blocked ? "ask" : "ok"}
        />
        <Big label="Prompt-injection cases stopped" value={`${m.injection.detected}/${m.injection.n}`} sub="injected text + a real fraud underneath" />
        <Big label="Reader field accuracy" value={pct(m.reader.rate)} sub={`${m.reader.ok}/${m.reader.total} fields · ${m.reader.perfectCases}/${m.reader.cases} docs perfect`} />
      </div>
      <p className="mt-3 font-mono text-[11px] text-ink-soft">
        Reader {run.model} · effort low · p50 {(m.latency.p50 / 1000).toFixed(1)} s · p95 {(m.latency.p95 / 1000).toFixed(1)} s · {usd(m.costUsd)} for {m.n} docs ({usd(m.n ? m.costUsd / m.n : 0)}/doc) · {m.errors} read errors · run {run.startedAt.slice(0, 16).replace("T", " ")} UTC
        {core && core.fraud.detected !== m.fraud.detected && ` · ablation: core rules R1–R12 alone would stop ${core.fraud.detected}/${core.fraud.n}`}
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div className="card overflow-x-auto p-0">
          <div className="px-4 pt-4">
            <div className="eyebrow">Unseen set · all {counts.unseen.docs} documents · as measured vs. current rules</div>
            <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">
              Same cached reads in both columns (zero new model calls). Only the left column is an unseen measurement; the right one used what the left exposed.
            </p>
          </div>
          <table className="mt-2 w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b-[1.5px] border-ink text-left font-mono text-[11px] uppercase tracking-wider text-ink-soft">
                <th className="px-4 py-2">Reader</th>
                <th className="px-2">Rules</th>
                <th className="px-2">Frauds stopped</th>
                <th className="px-2">Honest: blocked</th>
                <th className="px-2">Honest: clarify only</th>
                <th className="px-2 pr-4">Money wrong</th>
              </tr>
            </thead>
            <tbody>
              {compare.flatMap((c) =>
                (["measured", "current"] as const).map((k, i) => {
                  const s = c[k];
                  return (
                    <tr key={`${c.model}-${k}`} className={`border-b border-line ${k === mode ? "bg-[#f7f9cf]" : ""}`}>
                      <td className="px-4 py-1.5 font-semibold">{i === 0 ? modelName(c.model) : ""}</td>
                      <td className={`px-2 text-[12px] ${k === "current" ? "text-ask" : ""}`}>{k === "measured" ? "as measured (unseen)" : "current (re-scored)"}</td>
                      <td className="px-2 font-mono">
                        {s.fraud.detected}/{s.fraud.n}
                      </td>
                      <td className="px-2 font-mono">
                        {s.clean.blocked}/{s.clean.preN}
                      </td>
                      <td className="px-2 font-mono">
                        {s.clean.clarified}/{s.clean.preN}
                      </td>
                      <td className={`px-2 pr-4 font-mono ${s.moneyMovedWrongly ? "font-bold text-diff" : ""}`}>{s.moneyMovedWrongly}</td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
        <div className="card p-5 text-[14px] leading-relaxed">
          <div className="eyebrow">What a false alarm costs</div>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>
              <b>Asked to clarify</b> (CLARIFY): the client sees a question — “your nephew is not on the return, is that right?” — and can approve right away. Nothing is blocked; PayPal authorizes as usual.
            </li>
            <li>
              <b>Approval blocked</b> (DIFFERENCES / NEEDS_CONFIRMATION): no PayPal order is created. The client asks the preparer; the preparer fixes the return (or explains it) and re-uploads. <b>No money is lost</b> — the fee is simply not authorized yet.
            </li>
            <li>
              <b>After filing</b>, a false alarm is a proposed refund of an honest fee: the preparer gets 72 h to refute it with the IRS record before PayPal refunds anything. That is the only false alarm that can move money, and it is counted in “money moved wrongly”.
            </li>
            {Object.keys(m.clean.causes).length > 0 && (
              <li>
                Why honest returns were blocked here:{" "}
                {Object.entries(m.clean.causes)
                  .sort((a, b) => b[1] - a[1])
                  .map(([r, n]) => `${r} ${RULE_NAME[r] ?? ""} (${n})`)
                  .join(" · ")}
                . E.g. a family whose refunds go to a household account the client didn&apos;t list, or a draft sent before the preparer signed.
              </li>
            )}
          </ul>
        </div>
      </div>

      <details className="card mt-8 p-5 text-[14px] leading-relaxed">
        <summary className="cursor-pointer font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-soft">Methodology, caveats and where the models differ ▸</summary>
        <div className="mt-3 grid gap-4 text-[14px] leading-relaxed md:grid-cols-2">
        <div>
          <div className="eyebrow">How to read these numbers</div>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>
              <b>Everything is synthetic.</b> Every person, preparer, PTIN and account is invented; amounts follow approximate TY2025 rules. Fraud schemes follow IRS ghost-preparer warnings, but the documents are ours, not real returns.
            </li>
            <li>
              <b>How the split was made.</b> The dev corpus v1 ({counts.dev.cases} cases) is development data: the extra rules X1–X3 were written while looking at it, so its numbers are not a test. The unseen set is a separate generator (new seed, preparers, clients, amounts, family structures, filing statuses, layouts, name/account formats, visible injections), frozen by hash before any model or rule ran on it. Rules were not changed before these results were recorded; misses are reported as misses. <b>After</b> recording them we fixed four product bugs the set exposed (names printed “LAST, FIRST”, a draft without PTIN, first-year Schedule C losses, a refund whose deposit account can’t be read — e.g. a 3-way Form 8888 split) — so the “as measured” numbers describe the rules <i>before</i> those fixes, and the “current rules” view re-scores the same reads with them; the unseen set is no longer unseen for the fixed rules.
            </li>
            <li>
              <b>Which returns count where.</b> Lab: all {counts.unseen.returns} unseen returns × 3 document conditions = {counts.unseen.docs} documents; honest controls are {counts.unseen.honestPre} pre-filing + {counts.unseen.honestPost} post-filing returns per condition. Ghost-Preparer Radar: only the {counts.unseen.preFiling} pre-filing returns, one condition at a time — the radar scores what a preparer sends <i>before</i> the client signs (accounts, credits, preparer section); the {counts.unseen.postFiling} post-filing cases are IRS transcripts, which carry none of that.
            </li>
            <li>
              <b>Detection is rule-driven.</b> Claude never decides whether something is fraud. The reader&apos;s only job is to extract typed values; the deterministic rules compare them with the client&apos;s interview. That is why models that read the same values reach the same verdicts{devSame ? " — on the clean dev PDFs Opus, Sonnet and Haiku produce identical detection numbers" : ""}.
            </li>
          </ul>
        </div>
        <div>
          <div className="eyebrow">Where the models differ</div>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>
              Reader field accuracy on the unseen set: clean PDF {readerRange("pdf")}, scan {readerRange("scan")}, phone photo {readerRange("photo")} (range across models). A misread digit in an account, PTIN or dependents count changes a verdict, so scans and photos are where the model matters.
            </li>
            <li>
              {unseenRuns.length ? (
                unseenRuns.map((r) => {
                  const a = u(r.model, "pdf");
                  const b = u(r.model, "photo");
                  return (
                    <span key={r.id} className="mb-1 block">
                      <b>{modelName(r.model)}</b>: clean PDF → photo, frauds stopped {a ? `${a.fraud.detected}/${a.fraud.n}` : "—"} → {b ? `${b.fraud.detected}/${b.fraud.n}` : "—"} (for the right reason {a?.fraud.rightReason ?? "—"} → {b?.fraud.rightReason ?? "—"}), honest returns blocked {a ? `${a.clean.blocked}/${a.clean.preN}` : "—"} → {b ? `${b.clean.blocked}/${b.clean.preN}` : "—"}, money moved wrongly {a?.moneyMovedWrongly ?? "—"} → {b?.moneyMovedWrongly ?? "—"}; {r.summary.paired.verdictFlips}/{r.summary.paired.returns} returns get a different verdict depending on the document condition.
                    </span>
                  );
                })
              ) : (
                <span>No unseen run stored yet.</span>
              )}
            </li>
            {oracle && (
              <li>
                <b>Rule limits, not reader limits.</b> With a perfect reader (true values) the {mode === "measured" ? "rules as measured" : "current rules"} stop {oracle.fraud.detected}/{oracle.fraud.n} unseen frauds; of {oracle.clean.preN} honest pre-filing returns they block {oracle.clean.blocked} and ask the client to clarify on {oracle.clean.clarified}
                {Object.keys(oracle.clean.causes).length > 0 && ` (blocks: ${Object.entries(oracle.clean.causes).map(([r, n]) => `${r} ×${n}`).join(", ")})`}.{" "}
                {mode === "measured"
                  ? "At run time the blocks came from names printed “LAST, FIRST”, a draft without a PTIN, family refunds to a household account the client didn’t list and a genuine first-year Schedule C loss; the miss was a three-way Form 8888 split. Reported as found."
                  : "Today the name formats are matched, a first-year loss only asks the client to clarify, and an unreadable refund account blocks; the household-account refunds and an unsigned draft still block, by design — the client must confirm them."}
              </li>
            )}
            <li>Hidden (white or microscopic) text disappears when a page is scanned or photographed; the unseen set therefore also has visible injections — a cover-letter note, preparer notes in Spanish, a fake “IRS pre-validation” stamp.</li>
          </ul>
        </div>
      </div>
      </details>

      <div className="mt-10 grid gap-6 xl:grid-cols-[1fr_1fr]">
        <div>
          <h2 className="font-display text-[30px]">Detection by scheme</h2>
          <p className="text-[13px] text-ink-soft">Production rules · {modelName(run.model)} · {corpusName(run.corpus)} · {view === "all" ? "all conditions" : COND_SHORT[view]}. Weakest schemes first.</p>
          <div className="card mt-3 overflow-hidden" style={{ height: 520 }}>
            <AgGridReact theme={fcTheme} rowData={schemeRows} columnDefs={schemeCols} defaultColDef={{ sortable: true, resizable: true }} />
          </div>
        </div>
        <div>
          <h2 className="font-display text-[30px]">Model × document condition</h2>
          <div className="card mt-3 overflow-x-auto p-0">
            <table className="w-full min-w-[600px] text-[13px]">
              <thead>
                <tr className="border-b-[1.5px] border-ink text-left font-mono text-[11px] uppercase tracking-wider text-ink-soft">
                  <th className="px-4 py-3">Reader · corpus</th>
                  <th className="px-2">Condition</th>
                  <th className="px-2">Stopped</th>
                  <th className="px-2">Honest blocked · clarify</th>
                  <th className="px-2">Money wrong</th>
                  <th className="px-2">Reader</th>
                  <th className="px-2 pr-4">$/doc</th>
                </tr>
              </thead>
              <tbody>
                {runs.flatMap((r) =>
                  CONDS.filter((c) => r.summary.production.byCondition[c]).map((c, i) => {
                    const s = r.summary.production.byCondition[c]!;
                    return (
                      <tr key={`${r.id}-${c}`} className={`border-b border-line ${r.id === runId && (view === c || view === "all") ? "bg-[#f7f9cf]" : ""}`}>
                        <td className="px-4 py-2 font-semibold">{i === 0 ? <>{modelName(r.model)} <span className="font-mono text-[11px] font-normal text-ink-soft">· {r.corpus === "unseen" ? "unseen" : "dev v1"}{r.partial ? " (partial)" : ""}</span></> : ""}</td>
                        <td className="px-2">{COND_SHORT[c]}</td>
                        <td className="px-2 font-mono">{pct(s.fraud.rate)} <span className="text-ink-soft">({s.fraud.detected}/{s.fraud.n}; right reason {s.fraud.rightReason})</span></td>
                        <td className="px-2 font-mono">
                          {s.clean.blocked}/{s.clean.preN} · {s.clean.clarified}
                        </td>
                        <td className={`px-2 font-mono ${s.moneyMovedWrongly ? "font-bold text-diff" : ""}`}>{s.moneyMovedWrongly}</td>
                        <td className="px-2 font-mono">{pct(s.reader.rate)}</td>
                        <td className="px-2 pr-4 font-mono">{usd(s.n ? s.costUsd / s.n : 0)}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
            <p className="px-4 py-3 text-[12px] leading-snug text-ink-soft">Same rules everywhere; only the reader model and what it receives change. Dev v1 is clean PDFs only and is not a test set.</p>
          </div>

          {run.summary.paired.flips.length > 0 && (
            <div className="card mt-6 p-4">
              <div className="eyebrow">Same return, different document — verdict changed ({modelName(run.model)})</div>
              <ul className="mt-2 max-h-48 overflow-auto font-mono text-[12px]">
                {run.summary.paired.flips.map((f) => (
                  <li key={f.baseKey}>
                    {f.baseKey}: {CONDS.filter((c) => f.verdicts[c]).map((c) => `${COND_SHORT[c]} ${f.verdicts[c]}`).join(" · ")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card mt-6 p-4">
            <div className="eyebrow">Try one live</div>
            <p className="mt-1 text-[13px] text-ink-soft">Runs the real reader (the server&apos;s configured model) on one corpus document now, then the production rules. One read at a time; rate-limited.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select className="max-w-full rounded-md border-[1.5px] border-ink bg-sheet px-3 py-2 font-mono text-[13px]" value={liveKey} onChange={(e) => setLiveKey(e.target.value)} aria-label="Corpus document">
                {liveKeys.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.key}
                  </option>
                ))}
              </select>
              <button className="btn-primary" onClick={tryLive} disabled={live.loading}>
                {live.loading ? "Reading…" : "Run the reader"}
              </button>
              <a className="btn-secondary" href={liveKeys.find((c) => c.key === liveKey)?.doc} target="_blank" rel="noreferrer">
                Open document
              </a>
            </div>
            {live.error && <p className="mt-3 text-[13px] text-diff">{live.error}</p>}
            {live.data && (
              <div className="mt-3 grid gap-1 font-mono text-[12px]">
                <div>
                  {live.data.model} · {COND_SHORT[live.data.condition] ?? live.data.condition} · {(live.data.latencyMs / 1000).toFixed(1)} s · {usd(live.data.costUsd)} · reader {live.data.reader.ok}/{live.data.reader.total}
                </div>
                <div>
                  production rules: <b>{live.data.production.verdict}</b> {live.data.production.rules.join(" · ")}
                </div>
                <div className="font-sans text-[13px] text-ink-soft">{live.data.production.paypal}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <h2 className="mt-12 font-display text-[30px]">Every document</h2>
      <p className="text-[14px] text-ink-soft">Filter by condition, scheme, outcome or verdict. Click a row to see what the rules found and what PayPal would have done.</p>
      <div className="mt-3 grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="card overflow-hidden" style={{ height: 640 }}>
          <AgGridReact<CaseRow>
            theme={fcTheme}
            rowData={rows}
            columnDefs={caseCols}
            defaultColDef={{ sortable: true, resizable: true, filter: true }}
            onRowClicked={(e) => e.data && setSel(e.data)}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          />
        </div>
        <aside className="card h-fit p-5 lg:sticky lg:top-4">
          {!sel ? (
            <p className="text-[14px] text-ink-soft">Select a document.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="eyebrow">{sel.schemeLabel}</div>
                  <div className="font-mono text-[13px]">{sel.key}</div>
                  <div className="text-[12px] text-ink-soft">{CONDITION_LABEL[sel.condition]}</div>
                </div>
                <Stamp o={sel.production} fraud={sel.fraud} />
              </div>
              <p className="text-[14px] leading-snug">{sel.description}</p>
              <div className="text-[13px] text-ink-soft">
                Client {sel.clientName} · {sel.preparer}
              </div>
              {sel.injection && (
                <div className="rounded-md border-[1.5px] border-diff bg-diff-soft p-2 text-[12px]">
                  <b>Injected text</b> ({sel.injection.split(":")[0]}): “{sel.injection.slice(sel.injection.indexOf(":") + 2)}”
                </div>
              )}
              <div>
                <div className="eyebrow">What the production rules found</div>
                <div className="mt-1 font-mono text-[13px]">
                  {sel.production.verdict} · {sel.production.rules.join(" · ") || "no findings"}
                </div>
              </div>
              <div>
                <div className="eyebrow">What PayPal would have done</div>
                <p className="mt-1 text-[14px] leading-snug">{sel.production.paypal}</p>
              </div>
              <div>
                <div className="eyebrow">Reader</div>
                <p className="mt-1 font-mono text-[12px]">
                  {sel.readerOk}/{sel.readerTotal} fields · {(sel.latencyMs / 1000).toFixed(1)} s · {usd(sel.costUsd)}
                </p>
                {sel.error && <p className="text-[12px] text-diff">{sel.error}</p>}
                {sel.readerMisses.length > 0 && (
                  <ul className="mt-1 font-mono text-[11px] text-ink-soft">
                    {sel.readerMisses.slice(0, 8).map((x) => (
                      <li key={x.k}>
                        {x.k}: read {JSON.stringify(x.read)} · truth {JSON.stringify(x.truth)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <a className="btn-secondary" href={sel.doc} target="_blank" rel="noreferrer">
                  Open what the reader saw
                </a>
                {sel.doc !== sel.pdf && (
                  <a className="btn-secondary" href={sel.pdf} target="_blank" rel="noreferrer">
                    Clean PDF
                  </a>
                )}
                <button className="btn-secondary" onClick={() => setLiveKey(sel.key)}>
                  Select for live
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
      <p className="mt-10 max-w-[80ch] text-[12px] leading-relaxed text-ink-soft">
        “Production rules” = exactly what the app runs today: preFilingRules (R1–R12 plus the X1–X3 IRS-limit checks it now includes, each applied once) with the full-credit arithmetic check, and R14 on the normalized transcript after filing. “Stopped” = the verdict blocks the PayPal order (createOrder requires MATCH) or, after filing, R14 proposes a refund of the fee. “Warned only” = a CLARIFY the client must explicitly accept. “Money moved wrongly” = a fraud reached a silent MATCH (or after filing the fee capture stands), or an honest preparer&apos;s fee would be refunded. “Honest · blocked” = an honest return whose approval is blocked until the preparer fixes it or the client confirms: no PayPal order, no money lost. “Honest · asked to clarify” = the client sees a question and can still approve; nothing is blocked. After filing, a false alarm is a proposed refund of an honest fee (72 h for the preparer to refute) and counts as money moved wrongly.
      </p>
    </section>
  );
}
