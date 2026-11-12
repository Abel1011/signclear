"use client";
import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { registerAgGrid, fcTheme } from "@/components/agGrid";
import type { RadarLink, RadarPreparer } from "@/lib/radar";
import type { RadarEval } from "@/lib/lab/data";
import { Big } from "../lab/LabNav";

registerAgGrid();

type Prep = RadarPreparer & { kind: string; truthBad: boolean; note: string };
export type ViewData = {
  id: string;
  corpus: "dev" | "unseen";
  model: string;
  condition: string;
  cases: number;
  eval: RadarEval;
  links: RadarLink[];
  population: { cases: number; eitcRate: number };
  preparers: Prep[];
};

const LEVEL_CLS: Record<Prep["level"], string> = { HIGH: "text-diff", WATCH: "text-ask", LOW: "text-ok" };
const LEVEL_TXT: Record<Prep["level"], string> = { HIGH: "hold captures", WATCH: "watch", LOW: "low" };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const modelName = (m: string) => (m === "truth" ? "Ground truth (no reader)" : m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase()));
const COND: Record<string, string> = { pdf: "clean PDF", scan: "scan", photo: "phone photo", truth: "true values" };
const viewName = (v: ViewData) => `${v.corpus === "unseen" ? "Unseen" : "Dev v1"} · ${modelName(v.model)}${v.condition === "truth" ? "" : ` · ${COND[v.condition] ?? v.condition}`}`;

const HOLD_MEANS =
  "A hold only refuses the capture: the client's fee stays authorized in PayPal — not charged, not paid to the preparer, not refunded — until a person reviews the preparer. It never blocks the client's approval and never touches the refund.";

export function RadarClient({
  mode,
  views,
  defaultId,
  thresholds,
  totals,
}: {
  mode: "measured" | "current";
  views: ViewData[];
  defaultId: string;
  thresholds: { hold: number; watch: number };
  totals: Record<"unseen" | "dev", { returns: number; preFiling: number; postFiling: number }>;
}) {
  const [viewId, setViewId] = useState(defaultId);
  const v = views.find((x) => x.id === viewId) ?? views[0];
  const [selKey, setSelKey] = useState<string | null>(null);
  const preparers = v?.preparers ?? [];
  const sel = preparers.find((p) => p.preparerKey === selKey) ?? preparers[0] ?? null;
  const pickView = (id: string) => {
    setViewId(id);
    setSelKey(null);
  };
  const cols = useMemo<ColDef<Prep>[]>(
    () => [
      { field: "preparerName", headerName: "Preparer", flex: 2, minWidth: 240 },
      { field: "preparerKey", headerName: "PTIN", width: 125, cellClass: "font-mono text-[12px]" },
      { field: "kind", headerName: "Kind", width: 105, filter: "agSetColumnFilter", valueFormatter: (p) => (p.value === "ai_agent" ? "AI agent" : "human") },
      { field: "cases", headerName: "Returns", width: 100, type: "numericColumn" },
      {
        field: "score",
        headerName: "Risk score",
        width: 160,
        sort: "desc",
        cellRenderer: (p: ICellRendererParams<Prep>) => (
          <div className="flex items-center gap-2">
            <div className="h-2.5 flex-1 rounded-sm border border-ink/30 bg-sheet">
              <div className={p.data?.level === "HIGH" ? "h-full bg-diff" : p.data?.level === "WATCH" ? "h-full bg-ask" : "h-full bg-ok"} style={{ width: `${p.value}%` }} />
            </div>
            <span className="w-8 text-right font-mono text-[12px]">{p.value}</span>
          </div>
        ),
      },
      { field: "level", headerName: "Level", width: 140, filter: "agSetColumnFilter", cellRenderer: (p: ICellRendererParams<Prep>) => (p.data ? <span className={`stamp text-[10px] ${LEVEL_CLS[p.data.level]}`}>{LEVEL_TXT[p.data.level]}</span> : null) },
      { field: "truthBad", headerName: "Ground truth", width: 130, filter: "agSetColumnFilter", valueFormatter: (p) => (p.value ? "dishonest" : "honest"), cellClass: (p) => (p.value ? "font-bold" : "") },
      { field: "eitcRate", headerName: "EITC rate", width: 110, valueFormatter: (p) => pct(p.value) },
      { headerName: "Top reason", flex: 3, minWidth: 300, valueGetter: (p) => p.data?.reasons[0]?.text ?? "—", tooltipValueGetter: (p) => p.value },
    ],
    [],
  );
  if (!v)
    return (
      <section className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6">
        <div className="card p-6">No population to analyze yet.</div>
      </section>
    );
  const e = v.eval;
  const honestFlagged = preparers.filter((p) => !p.truthBad && p.level !== "LOW");
  const honestHeld = honestFlagged.filter((p) => p.hold).length;

  return (
    <section className="mx-auto max-w-[1280px] px-4 sm:px-6">
      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-end">
        <div className="max-w-[70ch]">
          <div className="eyebrow">Ghost-Preparer Radar · computed from what the reader extracted</div>
          <h1 className="mt-2 font-display text-[40px] leading-[1.04] sm:text-[54px]">
            One return can look innocent. <em className="hl">A preparer&apos;s pattern is harder to hide.</em>
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            The radar looks across cases for what single-case checks can&apos;t see: one refund account collecting other people&apos;s refunds, the same unrequested credit on client after client, abnormal EITC rates, blank or borrowed preparer sections. Every point of the score has a written reason. At {thresholds.hold}+ the money guardian holds that preparer&apos;s PayPal captures for human review. <b className="text-ink">A radar flag never moves money</b>: {HOLD_MEANS.split(": ")[1]}
          </p>
        </div>
        <div className="card flex flex-col gap-2 p-4">
          <label className="eyebrow" htmlFor="radar-view">
            Population
          </label>
          <select id="radar-view" className="rounded-md border-[1.5px] border-ink bg-sheet px-3 py-2 text-[14px]" value={v.id} onChange={(x) => pickView(x.target.value)}>
            {views.map((x) => (
              <option key={x.id} value={x.id}>
                {viewName(x)}
              </option>
            ))}
          </select>
          <p className="text-[12px] leading-snug text-ink-soft">
            {v.cases} pre-filing returns
            {v.cases === totals[v.corpus].preFiling ? ` — all of the ${totals[v.corpus].returns} ${v.corpus === "unseen" ? "unseen" : "dev"} returns except the ${totals[v.corpus].postFiling} post-filing cases (IRS transcripts carry no preparer section or refund account to compare)` : ` read without error (of ${totals[v.corpus].preFiling} pre-filing returns)`}
            {v.condition === "truth" ? " · true values" : ` · one document condition (${COND[v.condition] ?? v.condition})`} · {preparers.length} preparers · population EITC rate {pct(v.population.eitcRate)}
          </p>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Big label="Precision of “hold”" value={pct(e.precision)} sub={`${e.holdTP} of ${e.holdTP + e.holdFP} preparers on hold are dishonest`} tone={e.holdFP ? "diff" : "ok"} />
        <Big label="Recall of “hold”" value={pct(e.recall)} sub={`${e.holdTP} of ${e.bad} dishonest preparers put on hold${e.badMissed.length ? ` · missed ${e.badMissed.join(", ")}` : ""}`} tone={e.recall < 1 ? "diff" : "ok"} />
        <Big
          label="Honest preparers flagged"
          value={`${e.watchOrHoldFP}/${e.honest}`}
          sub={
            e.honestFlagged.length
              ? `${honestHeld} on hold (captures wait for a human), ${e.watchOrHoldFP - honestHeld} on watch (nothing held). No money moves either way — explained below.`
              : "none on watch or hold"
          }
          tone={honestHeld ? "ask" : "ok"}
        />
        <Big label="Shared foreign accounts" value={String(new Set(v.links.filter((l) => l.shared).map((l) => l.account)).size)} sub="accounts receiving refunds of ≥2 clients who didn't list them" />
      </div>

      {honestFlagged.length > 0 && (
        <div className="card mt-8 p-5 text-[14px] leading-relaxed">
          <div className="eyebrow">Honest but flagged — why, and what it costs them</div>
          <ul className="mt-3 grid gap-4 md:grid-cols-2">
            {honestFlagged.map((p) => (
              <li key={p.preparerKey} className="border-l-[3px] border-ask pl-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <button className="font-semibold underline underline-offset-2" onClick={() => setSelKey(p.preparerKey)}>
                    {p.preparerName}
                  </button>
                  <span className={`stamp text-[10px] ${LEVEL_CLS[p.level]}`}>
                    {LEVEL_TXT[p.level]} · {p.score}
                  </span>
                </div>
                {p.note && <p className="text-[13px] italic text-ink-soft">{p.note}</p>}
                <p className="mt-1 text-[13px]">
                  Signals: {p.reasons.slice(0, 2).map((r) => `${r.text} (+${r.points})`).join(" ")}
                </p>
                <p className="mt-1 text-[13px] text-ink-soft">
                  {p.hold
                    ? `Effect: their fees wait, authorized but not captured, until a reviewer confirms the pattern is legitimate${p.reasons.some((r) => r.code === "SHARED_ACCOUNT") ? " (here: that the shared account is the family's household account)" : ""}. Clients still review, approve and get their refunds normally; nothing is charged, refunded or redirected.`
                    : "Effect: watch only — nothing is held; captures proceed under the normal per-case rules."}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="card mt-8 p-5 text-[14px] leading-relaxed">
        <summary className="cursor-pointer font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-soft">What this measures, what it doesn’t, and every population ▸</summary>
        <div className="mt-3 grid gap-4 text-[14px] leading-relaxed md:grid-cols-[1fr_1.2fr]">
        <div>
          <div className="eyebrow">What this measures — and what it doesn&apos;t</div>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Synthetic population: every preparer, client, PTIN and account is fictitious.</li>
            <li>
              {mode === "measured"
                ? "As measured: radar and rules exactly as they were when the unseen set was run, on the values recorded then."
                : "Current rules: today's rules on the same cached reads, re-scored after the rules were fixed using this set — not an unseen measurement."}
            </li>
            <li>
              The radar is computed from the values the <b>reader extracted</b> from each document (pick the model and the document condition above), not from the ground truth — a misread account number or dependent count changes the score. The ground-truth row is only a reference.
            </li>
            <li>
              The unseen population includes <b>honest preparers with noisy-but-legit books</b>: a low-income clinic where nearly every client claims the EITC, a family preparer whose relatives&apos; refunds go to one household account, gig-economy clients with real Schedule C income and a first-year loss, a sloppy preparer who sends drafts and prints names “LAST, FIRST”. Dishonest preparers also file ordinary, correct returns.
            </li>
            <li>In the dev corpus v1 the dishonest preparers are exactly the ones committing its frauds, so its radar result is close to perfect by construction; treat it as a demo, not a measurement.</li>
          </ul>
        </div>
        <div className="overflow-x-auto">
          <div className="eyebrow">Every population</div>
          <table className="mt-2 w-full min-w-[460px] text-[13px]">
            <thead>
              <tr className="border-b-[1.5px] border-ink text-left font-mono text-[11px] uppercase tracking-wider text-ink-soft">
                <th className="py-2 pr-2">Population</th>
                <th className="px-2">Precision</th>
                <th className="px-2">Recall</th>
                <th className="px-2">Honest flagged</th>
              </tr>
            </thead>
            <tbody>
              {views.map((x) => (
                <tr key={x.id} className={`cursor-pointer border-b border-line ${x.id === v.id ? "bg-[#f7f9cf]" : ""}`} onClick={() => pickView(x.id)}>
                  <td className="py-1.5 pr-2">{viewName(x)}</td>
                  <td className="px-2 font-mono">
                    {pct(x.eval.precision)} <span className="text-ink-soft">({x.eval.holdTP}/{x.eval.holdTP + x.eval.holdFP})</span>
                  </td>
                  <td className="px-2 font-mono">
                    {pct(x.eval.recall)} <span className="text-ink-soft">({x.eval.holdTP}/{x.eval.bad})</span>
                  </td>
                  <td className={`px-2 font-mono ${x.eval.watchOrHoldFP ? "text-diff" : ""}`}>
                    {x.eval.watchOrHoldFP}/{x.eval.honest}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[12px] text-ink-soft">
            Precision/recall of “hold” (score ≥ {thresholds.hold}) against which preparers were built to be dishonest. “Honest flagged” counts watch (≥ {thresholds.watch}) or hold.
          </p>
        </div>
      </div>
      </details>

      <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_400px]">
        <div className="card overflow-hidden" style={{ height: 480 }}>
          <AgGridReact<Prep> theme={fcTheme} rowData={preparers} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true, filter: true }} onRowClicked={(x) => x.data && setSelKey(x.data.preparerKey)} tooltipShowDelay={300} />
        </div>
        <aside className="card h-fit p-5">
          {sel ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="eyebrow">
                    {sel.preparerKey} · ground truth: {sel.truthBad ? "dishonest" : "honest"}
                  </div>
                  <div className="font-display text-[26px] leading-tight">{sel.preparerName}</div>
                </div>
                <span className={`stamp text-[11px] ${LEVEL_CLS[sel.level]}`}>{sel.score}</span>
              </div>
              {sel.note && <p className="text-[13px] italic text-ink-soft">{sel.note}</p>}
              <div className="text-[13px] text-ink-soft">
                {sel.cases} returns · EITC on {pct(sel.eitcRate)} (population {pct(v.population.eitcRate)}) · {pct(sel.blockedRate)} blocked before approval
              </div>
              <ul className="flex flex-col gap-2">
                {sel.reasons.length === 0 && <li className="text-[14px] text-ink-soft">No cross-case signals.</li>}
                {sel.reasons.map((r, i) => (
                  <li key={i} className="border-l-[3px] border-ink pl-3 text-[14px] leading-snug">
                    <span className="font-mono text-[11px] font-bold">
                      +{r.points} {r.code}
                    </span>
                    <br />
                    {r.text}
                    <div className="font-mono text-[11px] text-ink-soft">{r.cases.join(", ")}</div>
                  </li>
                ))}
              </ul>
              <p className="text-[12px] text-ink-soft">Guardian: {sel.hold ? `PayPal captures for this preparer are held for human review (radarFlagsForPreparer → hold). ${HOLD_MEANS}` : "nothing held — captures proceed under the normal per-case rules."}</p>
            </div>
          ) : (
            <p className="text-ink-soft">Select a preparer.</p>
          )}
        </aside>
      </div>

      <h2 className="mt-12 font-display text-[30px]">Where the refunds go</h2>
      <p className="text-[14px] text-ink-soft">Preparers (left) linked to refund accounts that are not their clients&apos; own, as read from the documents (right). Highlighted accounts collect refunds of several clients.</p>
      <Network preparers={preparers} links={v.links} onPick={(k) => setSelKey(k)} sel={sel?.preparerKey} />
      <p className="mt-6 max-w-[80ch] text-[12px] leading-relaxed text-ink-soft">
        The radar only sees what SignClear sees (the client&apos;s answers, the typed values read from each return and the rule findings), never the ground-truth labels; precision and recall are scored against those labels afterwards. Built-in limitations: a preparer with one client gets no cross-case signal, and a family that legitimately shares an account looks like a mule pattern until someone confirms it.
      </p>
    </section>
  );
}

function Network({ preparers, links, onPick, sel }: { preparers: Prep[]; links: RadarLink[]; onPick: (k: string) => void; sel?: string }) {
  const accts = [...new Set(links.map((l) => l.account))].sort((a, b) => links.filter((l) => l.account === b).reduce((s, l) => s + l.cases.length, 0) - links.filter((l) => l.account === a).reduce((s, l) => s + l.cases.length, 0));
  const linked = preparers.filter((p) => links.some((l) => l.preparerKey === p.preparerKey));
  const rest = preparers.filter((p) => !linked.includes(p));
  const left = [...linked, ...rest];
  const rowH = 34;
  const H = Math.max(left.length, accts.length) * rowH + 30;
  const W = 900;
  const ly = (i: number) => 24 + i * rowH;
  const ry = (i: number) => 24 + i * (((Math.max(left.length, accts.length) - 1) * rowH) / Math.max(1, accts.length - 1 || 1));
  const color = (p: Prep) => (p.level === "HIGH" ? "var(--color-diff)" : p.level === "WATCH" ? "var(--color-ask)" : "var(--color-ink-soft)");
  return (
    <div className="card mt-3 overflow-x-auto p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px]" role="img" aria-label="Network of preparers and refund accounts">
        {links.map((l, i) => {
          const pi = left.findIndex((p) => p.preparerKey === l.preparerKey);
          const ai = accts.indexOf(l.account);
          const p = left[pi];
          const y1 = ly(pi);
          const y2 = accts.length === 1 ? ly(0) : ry(ai);
          return <path key={i} d={`M 330 ${y1} C 520 ${y1}, 560 ${y2}, 690 ${y2}`} fill="none" stroke={color(p)} strokeOpacity={sel && sel !== l.preparerKey ? 0.18 : 0.85} strokeWidth={1 + l.cases.length * 1.4} />;
        })}
        {left.map((p, i) => (
          <g key={p.preparerKey} onClick={() => onPick(p.preparerKey)} style={{ cursor: "pointer" }}>
            <circle cx={330} cy={ly(i)} r={7} fill={color(p)} stroke="var(--color-ink)" strokeWidth={sel === p.preparerKey ? 2.5 : 1} />
            <text x={316} y={ly(i) + 4} textAnchor="end" fontSize={13} fill="var(--color-ink)" fontWeight={sel === p.preparerKey ? 700 : 400}>
              {p.preparerName.length > 38 ? p.preparerName.slice(0, 37) + "…" : p.preparerName} · {p.score}
            </text>
          </g>
        ))}
        {accts.map((a, i) => {
          const ls = links.filter((l) => l.account === a);
          const shared = ls.some((l) => l.shared);
          const n = ls.reduce((s, l) => s + l.cases.length, 0);
          const y = accts.length === 1 ? ly(0) : ry(i);
          return (
            <g key={a}>
              <rect x={690} y={y - 11} width={120} height={22} rx={3} fill={shared ? "var(--color-mark)" : "var(--color-sheet)"} stroke="var(--color-ink)" strokeWidth={1.5} />
              <text x={750} y={y + 4} textAnchor="middle" fontSize={12} fontFamily="JetBrains Mono, monospace" fill="var(--color-ink)">
                ****{a}
              </text>
              <text x={820} y={y + 4} fontSize={11} fill="var(--color-ink-soft)">
                {n} refund{n > 1 ? "s" : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
