"use client";
import { useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { registerAgGrid, fcLogTheme } from "./agGrid";
import type { AuditRow } from "./useCase";
import { paypalCall, cachedReadNote, type PayRef, type PayPalCall } from "@/lib/paypal-calls";

registerAgGrid();

type R = AuditRow & { time: string; what: string; result: string; pp: PayPalCall | null };

const ACTOR: Record<string, { l: string; cls: string }> = {
  ai: { l: "Agent", cls: "bg-indigo-500/20 text-indigo-200" },
  rules: { l: "Rules", cls: "bg-slate-500/25 text-slate-200" },
  user: { l: "Person", cls: "bg-slate-500/25 text-slate-200" },
  paypal: { l: "PayPal", cls: "bg-sky-500/25 text-sky-200" },
  system: { l: "Engine", cls: "bg-slate-500/20 text-slate-300" },
  guardian: { l: "Guardian", cls: "bg-rose-500/25 text-rose-200" },
};

export function AgentLog({ rows, payment }: { rows: AuditRow[]; payment?: PayRef }) {
  const data: R[] = useMemo(
    () =>
      [...rows]
        .filter((r) => r.action !== "notification" || true)
        .reverse()
        .map((r) => {
          const pp = paypalCall(r, payment);
          return {
            ...r,
            pp,
            time: new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
            what: pp ? pp.label : pretty(r),
            result: pp ? ppSummary(pp) : summarize(r),
          };
        }),
    [rows, payment],
  );
  const cols: ColDef<R>[] = [
    { field: "time", headerName: "Time", width: 96, cellClass: "tabular-nums text-slate-400" },
    {
      field: "actor",
      headerName: "Who",
      width: 110,
      cellRenderer: (p: ICellRendererParams<R>) => {
        const a = ACTOR[p.value] ?? ACTOR.system;
        return <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${a.cls}`}>{a.l}</span>;
      },
    },
    {
      field: "what",
      headerName: "Action",
      flex: 1.3,
      cellRenderer: (p: ICellRendererParams<R>) => (
        <span className={p.data?.actor === "guardian" ? "font-semibold text-rose-300" : p.data?.actor === "paypal" ? "font-semibold text-sky-300" : "text-slate-100"}>{p.value}</span>
      ),
    },
    { field: "rationale", headerName: "Agent rationale", flex: 2, wrapText: true, autoHeight: true, cellClass: "text-slate-300 italic" },
    { field: "result", headerName: "Result", flex: 1.7, wrapText: true, autoHeight: true },
    {
      field: "debugId",
      headerName: "PayPal-Debug-Id",
      width: 190,
      cellClass: "font-mono text-xs text-sky-300",
      cellRenderer: (p: ICellRendererParams<R>) =>
        p.data?.pp ? (
          <span className="select-all">
            {p.value ?? "—"}
            {p.data.pp.link && (
              <a href={p.data.pp.link} target="_blank" rel="noreferrer" title="Open in the PayPal sandbox (merchant login)" className="ml-1.5 text-sky-200 underline">
                ↗
              </a>
            )}
          </span>
        ) : (
          (p.value ?? "")
        ),
    },
  ];
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 900);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  if (narrow)
    return (
      <div className="h-full space-y-1.5 overflow-y-auto pr-1">
        {data.map((r) => {
          const a = ACTOR[r.actor] ?? ACTOR.system;
          return (
            <div key={r.id} className="rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-200">
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 font-semibold ${a.cls}`}>{a.l}</span>
                <span className="font-medium">{r.what}</span>
                <span className="ml-auto tabular-nums text-slate-500">{r.time}</span>
              </div>
              {r.rationale && <div className="mt-1 italic text-slate-400">{r.rationale}</div>}
              {r.result && <div className="mt-1 text-slate-300">{r.result}</div>}
              {r.pp && (
                <div className="mt-1 break-all font-mono text-[11px] text-sky-300">
                  Debug-ID {r.debugId ?? "—"}
                  {r.pp.link && (
                    <a href={r.pp.link} target="_blank" rel="noreferrer" className="ml-2 underline">
                      sandbox ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  return (
    <div className="h-full">
      <AgGridReact<R>
        theme={fcLogTheme}
        rowData={data}
        columnDefs={cols}
        defaultColDef={{ suppressHeaderMenuButton: true, sortable: false }}
        suppressNoRowsOverlay
        rowHeight={34}
      />
    </div>
  );
}

function pretty(r: AuditRow): string {
  const a = r.action.replace(/^tool:/, "→ ").replace(/_/g, " ");
  if (r.from || r.to) return `${a}  ${r.from ?? ""} → ${r.to ?? ""}`;
  return a;
}

/** PayPal rows: endpoint, object id and outcome (the Debug-ID has its own column). */
function ppSummary(p: PayPalCall): string {
  const parts = [p.endpoint, p.objectId ? `${p.objectKind} ${p.objectId}` : null, p.httpStatus ? `HTTP ${p.httpStatus}` : null, p.ppStatus].filter(Boolean);
  return parts.join(" · ");
}

function summarize(r: AuditRow): string {
  const d = r.detail as Record<string, unknown>;
  const cached = cachedReadNote(r);
  if (cached) return cached;
  if (Array.isArray(d.conditions)) return `BLOCKED — ${(d.conditions as string[]).join(" · ")}`;
  if (d.status !== undefined) return `HTTP ${d.status}${d.pp ? ` · ${d.pp}` : ""}`;
  if (d.verdict) return `verdict: ${String(d.verdict)}`;
  if (d.findings) return (d.findings as string[]).join(", ") || "no differences";
  if (d.text) return String(d.text);
  if (d.error) return `fallback (deterministic): ${String(d.error).slice(0, 60)}`;
  if (d.mode) return `${d.mode}${d.fields ? ` · ${d.fields} fields` : ""}${d.simulated ? " · SIMULATED" : ""}`;
  if (d.hours) return `+${d.hours} h · simulated clock`;
  if (d.authorizationId) return `authorization ${d.authorizationId}`;
  return "";
}
