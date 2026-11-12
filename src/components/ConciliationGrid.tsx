"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, ICellRendererParams, IRowNode } from "ag-grid-community";
import { registerAgGrid, fcTheme } from "./agGrid";
import type { Row, RowStatus } from "@/lib/rows";
import { tr, type Lang } from "./useCase";

registerAgGrid();

const STATUS: Record<RowStatus, { l: Record<Lang, string>; cls: string; dot: string }> = {
  MATCH: { l: { es: "Coincide", en: "Matches", pt: "Confere" }, cls: "text-ok", dot: "bg-ok" },
  CLARIFY: { l: { es: "Aclarar", en: "Clarify", pt: "Esclarecer" }, cls: "border-[1.5px] border-ink bg-mark text-ink", dot: "bg-ink" },
  DIFFERENT: { l: { es: "Diferente", en: "Different", pt: "Diferente" }, cls: "border-[1.5px] border-diff bg-diff text-sheet", dot: "bg-sheet" },
  CONFIRMED: { l: { es: "Confirmado por usted", en: "Confirmed by you", pt: "Confirmado por você" }, cls: "border-[1.5px] border-ok text-ok", dot: "bg-ok" },
  NOCHECK: { l: { es: "Sin papel para comparar", en: "No paper to compare", pt: "Sem documento" }, cls: "text-ink-soft", dot: "bg-ink-soft/50" },
};

const H: Record<string, Record<Lang, string>> = {
  concept: { es: "Concepto", en: "Item", pt: "Item" },
  declaration: { es: "Su declaración", en: "Your return", pt: "Sua declaração" },
  compare: { es: "Comparado con", en: "Compared with", pt: "Comparado com" },
  status: { es: "¿Coincide?", en: "Matches?", pt: "Confere?" },
  f8879: { es: "Hoja 8879", en: "Form 8879", pt: "Form. 8879" },
  papers: { es: "Sus papeles", en: "Your papers", pt: "Seus documentos" },
  told: { es: "Lo que nos dijo", en: "What you told us", pt: "O que nos disse" },
  irs: { es: "Registro del IRS", en: "IRS record", pt: "Registro do IRS" },
  bank: { es: "Llegó a su cuenta", en: "Reached your account", pt: "Chegou à sua conta" },
  reading: { es: "Leyendo su declaración", en: "Reading your return", pt: "Lendo sua declaração" },
  ask: { es: "Pídale algo a la tabla, en su idioma…", en: "Ask the table, in any language…", pt: "Peça algo à tabela, no seu idioma…" },
};

type GridRow = Row & { section: string; conceptText: string; compareSrc: string };

export function ConciliationGrid({
  rows,
  lang,
  focusRow,
  onSelect,
  animate = true,
  token,
  alertRow,
}: {
  rows: Row[];
  lang: Lang;
  focusRow?: string | null;
  onSelect?: (r: Row) => void;
  animate?: boolean;
  token?: string;
  /** A row that must stay unmistakable (e.g. the refund going to someone else's account). */
  alertRow?: string | null;
}) {
  const apiRef = useRef<GridApi<GridRow> | null>(null);
  const animKey = `fc_anim_${token ?? "x"}`;
  const [revealed, setRevealed] = useState(() => {
    try {
      if (!animate || sessionStorage.getItem(animKey)) return rows.length;
    } catch {}
    return 0;
  });
  useEffect(() => {
    if (revealed >= rows.length && rows.length) {
      try {
        sessionStorage.setItem(animKey, "1");
      } catch {}
    }
  }, [revealed, rows.length, animKey]);
  const [onlyReview, setOnlyReview] = useState(false);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [width, setWidth] = useState(1400);
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const narrow = width < 900;
  const phone = width < 640;

  useEffect(() => {
    if (revealed >= rows.length) return;
    const t = setTimeout(() => setRevealed((n) => n + 1), 260);
    return () => clearTimeout(t);
  }, [revealed, rows.length]);
  // Never leave the reading animation half-way (e.g. throttled background tab).
  useEffect(() => {
    const t = setTimeout(() => setRevealed((n) => Math.max(n, rows.length)), 4500);
    return () => clearTimeout(t);
  }, [rows.length]);
  const done = revealed >= rows.length;
  const hasPost = rows.some((r) => r.irs !== undefined);

  const data: GridRow[] = useMemo(
    () =>
      rows.slice(0, revealed).map((r) => ({
        ...r,
        section: tr(r.group, lang),
        conceptText: tr(r.concept, lang),
        compareSrc: tr(r.compareLabel, lang),
      })),
    [rows, revealed, lang],
  );

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !data.length || done) return;
    const node = api.getRowNode(data[data.length - 1].key);
    if (node) api.flashCells({ rowNodes: [node], flashDuration: 500, fadeDuration: 500 });
  }, [data, done]);

  const flashKey = useRef<string | null>(null);
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !focusRow) return;
    const key = focusRow.split(":")[0];
    const node = api.getRowNode(key);
    // The grid grows to full height, so scroll the PAGE container to the row (instant: reliable everywhere).
    const el = document.querySelector(`.ag-row[row-id="${key}"]`) as HTMLElement | null;
    if (el && !focusRow.endsWith(":auto")) {
      let p: HTMLElement | null = el.parentElement;
      while (p && !(p.scrollHeight > p.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
      if (p) {
        const r = el.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        p.scrollTop += r.top - pr.top - pr.height / 2 + r.height / 2;
      } else el.scrollIntoView({ block: "center" });
    }
    if (node) {
      // Highlight through a row-class rule so AG Grid's re-renders don't wipe it.
      flashKey.current = key;
      api.redrawRows({ rowNodes: [node] });
      const t = setTimeout(() => {
        flashKey.current = null;
        api.redrawRows({ rowNodes: [node] });
      }, 2600);
      return () => clearTimeout(t);
    }
  }, [focusRow, done]);

  useEffect(() => {
    apiRef.current?.onFilterChanged();
  }, [onlyReview]);

  const money = "text-[15px] font-semibold tabular-nums text-ink";
  const cols: ColDef<GridRow>[] = useMemo(
    () => [
      { field: "section", rowGroup: true, hide: true, filter: "agSetColumnFilter" },
      {
        field: "conceptText",
        headerName: H.concept[lang],
        filter: "agTextColumnFilter",
        flex: 1.8,
        minWidth: narrow ? 140 : 220,
        cellRenderer: (p: ICellRendererParams<GridRow>) => (
          <div className="flex min-w-0 flex-col justify-center leading-tight">
            <span className="line-clamp-2 whitespace-normal font-medium text-ink"><span className={done && p.data?.status !== "MATCH" && p.data?.status !== "NOCHECK" ? "hl hl-anim" : ""}>{p.data?.conceptText}</span></span>
            <span className="mt-0.5 truncate text-xs text-ink-soft">{p.data?.cite}</span>
          </div>
        ),
      },
      {
        field: "declaration",
        headerName: H.declaration[lang],
        flex: 1.2,
        minWidth: narrow ? 110 : 150,
        cellRenderer: (p: ICellRendererParams<GridRow>) =>
          narrow || hasPost ? (
            <div className="flex min-w-0 flex-col justify-center leading-tight">
              <span className={money}>{p.value}</span>
              <span className="mt-0.5 truncate text-xs text-ink-soft">
                {p.data?.compareSrc}: {p.data?.compare}
              </span>
            </div>
          ) : (
            <span className={money}>{p.value}</span>
          ),
      },
      {
        field: "compare",
        headerName: H.compare[lang],
        flex: 1.4,
        minWidth: 170,
        hide: all || narrow || hasPost,
        cellRenderer: (p: ICellRendererParams<GridRow>) => (
          <div className="flex min-w-0 flex-col justify-center leading-tight">
            <span className="truncate tabular-nums text-ink">{p.data?.compare}</span>
            <span className="mt-0.5 text-xs text-ink-soft">{p.data?.compareSrc}</span>
          </div>
        ),
      },
      { field: "f8879", headerName: H.f8879[lang], flex: 1, hide: !all, cellClass: "tabular-nums" },
      { field: "papers", headerName: H.papers[lang], flex: 1, hide: !all, cellClass: "tabular-nums" },
      { field: "told", headerName: H.told[lang], flex: 1.1, hide: !all },
      {
        field: "irs",
        headerName: H.irs[lang],
        flex: 1,
        hide: !hasPost,
        cellRenderer: (p: ICellRendererParams<GridRow>) => (p.value ? <span className={money}>{p.value}</span> : null),
      },
      {
        field: "bank",
        headerName: H.bank[lang],
        flex: 1.1,
        hide: !hasPost,
        cellRenderer: (p: ICellRendererParams<GridRow>) =>
          p.value ? <span className={`${money} ${p.data?.irs && p.value !== p.data.irs ? "rounded-md bg-diff-soft px-2 py-1 text-diff" : ""}`}>{p.value}</span> : null,
      },
      {
        // Hidden numeric twin of "declaration" so the AI Toolkit can apply number filters ("over $2,000").
        colId: "amount",
        headerName: "Amount (USD)",
        hide: true,
        filter: "agNumberColumnFilter",
        valueGetter: (p) => {
          const m = /^-?\$?-?[\d,]+(\.\d+)?$/.test(String(p.data?.declaration ?? "").trim()) ? Number(String(p.data?.declaration).replace(/[$,]/g, "")) : null;
          return m;
        },
      },
      {
        field: "status",
        headerName: H.status[lang],
        filter: "agSetColumnFilter",
        flex: 1,
        minWidth: narrow ? 108 : 150,
        cellRenderer: (p: ICellRendererParams<GridRow>) => {
          if (!done) return <span className="inline-block h-2 w-16 animate-pulse rounded bg-slate-200" />;
          const s = STATUS[(p.data?.status ?? "NOCHECK") as RowStatus];
          return (
            <span className={`inline-flex h-7 items-center gap-2 whitespace-nowrap rounded-sm px-2.5 font-mono text-[11px] font-bold uppercase tracking-wider leading-none ${s.cls}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
              {s.l[lang]}
            </span>
          );
        },
      },
    ],
    [lang, all, hasPost, done, narrow],
  );

  async function askGrid() {
    const api = apiRef.current;
    if (!api || !q.trim()) return;
    setAiBusy(true);
    setAiMsg(null);
    const before = JSON.stringify(api.getState());
    try {
      const schema = api.getStructuredSchema({
        exclude: ["pivot", "aggregation", "columnSizing"],
        columns: {
          status: { description: "Comparison result. MATCH = matches; CLARIFY = needs clarifying; DIFFERENT = differs; NOCHECK = no paper to compare. 'Only what doesn't match' means every value except MATCH.", includeSetValues: true },
          section: { description: "Group of the item: family, earnings, government credits, refund, preparer (in the client's language).", includeSetValues: true },
          conceptText: { description: "Name of the tax item in the client's language." },
          amount: { description: "Dollar amount of the item on the return, as a number (null for non-money rows like names or counts). Use a number filter for requests like 'over 2000' or 'less than $500'." },
        },
      });
      const res = await fetch("/api/grid-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // AG Grid's schema can contain boxed strings/objects with toString(); serialize them as plain strings.
        body: JSON.stringify({ token, schema, state: api.getState(), query: q }, (_k, v) =>
          v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && typeof v.toString === "function" && v.toString() !== "[object Object]"
            ? v.toString()
            : v,
        ),
      });
      const j = await res.json();
      if (!res.ok || !j.result) throw new Error(j.error ?? "no result");
      const r = j.result as { gridState?: unknown; propertiesToIgnore?: string[] };
      const next = (r.gridState ?? r) as Parameters<GridApi["setState"]>[0];
      api.setState(next, r.propertiesToIgnore as never);
      if (JSON.stringify(api.getState()) === before) throw new Error("no change");
      setOnlyReview(false);
      setAiMsg("AG Grid AI Toolkit");
    } catch {
      // Deterministic fallback for the most common request, labelled honestly.
      if (/n[aã]o bate|no coincid|differ|mismatch|review|revis|n[aã]o confere|doesn.?t match/i.test(q)) {
        setOnlyReview(true);
        setAiMsg(tr({ es: "filtro aplicado", en: "filter applied", pt: "filtro aplicado" }, lang));
      } else setAiMsg(tr({ es: "No entendí; pruebe «solo lo que no coincide»", en: "Not understood; try “only what doesn't match”", pt: "Não entendi; tente «só o que não bate»" }, lang));
    } finally {
      setAiBusy(false);
    }
  }

  const issues = rows.filter((r) => r.status !== "MATCH").length;
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-4 sm:px-5">
        <div className="mr-auto min-w-0 basis-full sm:basis-auto">
          <div className="font-display text-xl font-semibold text-ink">
            {tr({ es: "Su declaración, punto por punto", en: "Your return, item by item", pt: "Sua declaração, ponto a ponto" }, lang)}
          </div>
          <div className="text-sm text-ink-soft">
            {done
              ? tr({ es: "Comparamos su declaración con sus papeles y con lo que nos contó.", en: "We compare your return with your papers and what you told us.", pt: "Comparamos sua declaração com seus documentos e o que você nos contou." }, lang)
              : `${H.reading[lang]}… ${revealed}/${rows.length}`}
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-md border-[1.5px] border-ink/20 bg-paper p-0.5">
          <button
            onClick={() => {
              setOnlyReview(false);
              apiRef.current?.setFilterModel(null);
              setAiMsg(null);
            }}
            className={`chip border-0 ${!onlyReview && !aiMsg ? "chip-on" : "bg-transparent"}`}
          >
            {tr({ es: "Todo", en: "All", pt: "Tudo" }, lang)} · {rows.length}
          </button>
          <button
            onClick={() => {
              apiRef.current?.setFilterModel(null);
              setAiMsg(null);
              setOnlyReview(true);
            }}
            className={`chip border-0 ${onlyReview ? "chip-on" : "bg-transparent"}`}
          >
            {tr({ es: "Por revisar", en: "To review", pt: "A revisar" }, lang)} · {issues}
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" className="accent-brand" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {tr({ es: "Todas las fuentes", en: "All sources", pt: "Todas as fontes" }, lang)}
        </label>
      </div>
      <div className={`${phone ? "hidden" : "flex"} items-center gap-2 border-b border-line bg-paper/60 px-4 py-2.5 sm:px-5`}>
        <span className="text-sm">✨</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && askGrid()}
          placeholder={H.ask[lang]}
          className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-soft"
        />
        {aiMsg && <span className="text-xs font-medium text-ok">✓ {aiMsg}</span>}
        <button onClick={askGrid} disabled={aiBusy || !q.trim()} className="rounded-lg bg-ink px-3 py-1 text-xs font-semibold text-white disabled:opacity-30">
          {aiBusy ? "…" : tr({ es: "Aplicar", en: "Apply", pt: "Aplicar" }, lang)}
        </button>
      </div>
      {phone ? (
        <div className="divide-y divide-line">
          {data
            .filter((r) => !onlyReview || r.status !== "MATCH")
            .map((r) => {
              const st = STATUS[r.status];
              return (
                <button key={r.key} onClick={() => onSelect?.(r)} className={`block w-full px-4 py-3.5 text-left ${r.key === alertRow ? "border-l-[5px] border-diff bg-diff-soft" : focusRow?.startsWith(r.key) ? "bg-ask-soft" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-ink-soft">{r.section}</div>
                      <div className="font-medium text-ink">{r.conceptText}</div>
                    </div>
                    {done && (
                      <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 font-mono text-[10px] font-bold uppercase tracking-wider ${st.cls}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                        {st.l[lang]}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-lg font-semibold tabular-nums text-ink">{r.declaration}</span>
                    <span className="truncate text-right text-ink-soft">
                      {r.compareSrc}: {r.compare}
                    </span>
                  </div>
                  {r.bank && (
                    <div className="mt-1 text-sm text-diff">
                      {H.irs[lang]}: {r.irs} · {H.bank[lang]}: {r.bank}
                    </div>
                  )}
                  <div className="mt-0.5 text-xs text-ink-soft">{r.cite}</div>
                </button>
              );
            })}
        </div>
      ) : (
      <AgGridReact<GridRow>
        theme={fcTheme}
        rowData={data}
        columnDefs={cols}
        getRowId={(p) => p.data.key}
        domLayout="autoHeight"
        groupDefaultExpanded={-1}
        groupDisplayType="groupRows"
        groupRowRendererParams={{ suppressCount: true }}
        suppressMovableColumns
        defaultColDef={{ resizable: false, sortable: false, suppressHeaderMenuButton: true, enableCellChangeFlash: true, cellStyle: { display: "flex", alignItems: "center" } }}
        getRowHeight={(p) => (p.node.group ? 44 : narrow ? 76 : 66)}
        // The reading animation starts from 0 rows; AG Grid would keep announcing its "no rows" text in an
        // aria-live region for the whole case. The header already shows the reading progress.
        localeText={{
          noRowsToShow: " ",
          noMatchingRows: tr({ es: "Nada por revisar: todo coincide ✓", en: "Nothing to review: everything matches ✓", pt: "Nada a revisar: tudo confere ✓" }, lang),
        }}
        onCellClicked={(e) => e.data && !e.node.group && onSelect?.(e.data)}
        isExternalFilterPresent={() => onlyReview}
        doesExternalFilterPass={(n: IRowNode<GridRow>) => !onlyReview || (n.data?.status !== "MATCH" && n.data?.status !== "CONFIRMED")}
        onGridReady={(e) => (apiRef.current = e.api)}
        rowClass="cursor-pointer"
        rowClassRules={{ "fc-row-focus": (p) => !!p.data && p.data.key === flashKey.current }}
        getRowStyle={(p) => (alertRow && p.data?.key === alertRow ? { background: "var(--color-diff-soft)", boxShadow: "inset 5px 0 0 var(--color-diff)", fontWeight: 600 } : undefined)}
      />
      )}
    </div>
  );
}
