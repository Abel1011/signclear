"use client";
import { useCallback, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { registerAgGrid, fcTheme } from "./agGrid";
import { usd } from "./useCase";
import type { LedgerResult, LedgerRow } from "@/lib/paypal-ledger";

registerAgGrid();

const VERDICT: Record<LedgerRow["verdict"], { t: string; c: string }> = {
  MATCH: { t: "Matches PayPal", c: "text-ok" },
  AMOUNT_MISMATCH: { t: "Amount differs", c: "text-diff font-semibold" },
  STATUS_MISMATCH: { t: "Status differs", c: "text-diff font-semibold" },
  AWAITING_PAYPAL_SYNC: { t: "Waiting for PayPal report (lag)", c: "text-ink-soft" },
  MISSING_AT_PAYPAL: { t: "Not in PayPal report", c: "text-diff font-semibold" },
  UNKNOWN_TO_SIGNCLEAR: { t: "Only in PayPal", c: "text-diff font-semibold" },
  NOT_CHECKED: { t: "Not checked", c: "text-ink-soft" },
};

/** SignClear's ledger vs. PayPal Transaction Search, flagged per movement. */
export function LedgerGrid({ tokens }: { tokens: string[] }) {
  const [res, setRes] = useState<LedgerResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/preparer/ledger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokens, days: 30 }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.error ?? `Reconciliation failed (HTTP ${r.status}).`);
      else setRes(j);
    } catch {
      setErr("Could not reach the server. Try again.");
    } finally {
      setCheckedAt(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }));
      setBusy(false);
    }
  }, [tokens]);
  const cols: ColDef<LedgerRow>[] = [
    { field: "client", headerName: "Client", flex: 1.1, cellClass: "font-semibold" },
    { field: "kind", headerName: "Movement", flex: 0.8, valueFormatter: (p) => (p.value === "PAYPAL_ONLY" ? "PayPal only" : `${String(p.value).toLowerCase()} · ${p.data?.line.toLowerCase()}`) },
    { field: "paypalId", headerName: "PayPal ID", flex: 1.3, cellClass: "font-mono text-xs" },
    { field: "signclearCents", headerName: "SignClear", flex: 0.7, cellClass: "font-mono", valueFormatter: (p) => (p.value == null ? "—" : usd(p.value)) },
    { field: "paypalCents", headerName: "PayPal", flex: 0.7, cellClass: "font-mono", valueFormatter: (p) => (p.value == null ? "—" : usd(p.value)) },
    { field: "paypalStatus", headerName: "PP status", flex: 0.6, cellClass: "font-mono", valueFormatter: (p) => p.value ?? "—" },
    {
      field: "verdict",
      headerName: "Reconciliation",
      flex: 1.4,
      cellRenderer: (p: ICellRendererParams<LedgerRow>) => {
        const v = VERDICT[p.value as LedgerRow["verdict"]];
        return <span className={v?.c}>{v?.t ?? p.value}</span>;
      },
    },
  ];
  const flagged = res?.rows.filter((r) => ["AMOUNT_MISMATCH", "STATUS_MISMATCH", "MISSING_AT_PAYPAL", "UNKNOWN_TO_SIGNCLEAR"].includes(r.verdict)).length ?? 0;
  const matched = res?.rows.filter((r) => r.verdict === "MATCH").length ?? 0;
  const unchecked = res?.rows.filter((r) => r.verdict === "NOT_CHECKED" || r.verdict === "AWAITING_PAYPAL_SYNC").length ?? 0;
  // One plain result line after every run: what matched, what didn't, and why something wasn't checked.
  const summary = !res
    ? null
    : !res.paypal.available
      ? { tone: "text-diff", text: `Not checked — PayPal report unavailable: ${res.paypal.reason ?? `HTTP ${res.paypal.status}`}. ${res.rows.length} SignClear movement(s) left unverified.` }
      : !res.rows.length
        ? { tone: "text-ink-soft", text: `Checked ${res.paypal.count} PayPal transaction(s): nothing to reconcile yet (no captures or refunds).` }
        : {
            tone: flagged ? "text-diff" : "text-ok",
            text: `${matched} matched · ${flagged} mismatched · ${unchecked} not checked yet${unchecked ? " (PayPal's report lags; re-check later)" : ""}.`,
          };
  return (
    <div className="mt-5 border-t border-dashed border-ink/25 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow">Ledger · PayPal Transaction Search</div>
          <div className="text-xs text-ink-soft">
            Compares every capture and refund SignClear recorded with PayPal&apos;s own report (last 30 days). PayPal reports can lag up to {res?.lagHours ?? 3} h; sandbox often more.
          </div>
        </div>
        <button disabled={busy || !tokens.length} onClick={load} aria-busy={busy} className="btn-secondary inline-flex items-center gap-2 py-1.5 text-sm">
          {busy && <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/30 border-t-ink" />}
          {busy ? "Checking PayPal…" : res ? "Re-check" : "Reconcile with PayPal"}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {err && <div className="mt-2 text-sm font-semibold text-diff">Not checked — {err}</div>}
        {!err && summary && (
          <div className={`mt-2 text-sm font-semibold ${summary.tone}`}>
            {summary.text}
            {checkedAt && <span className="ml-2 font-mono text-[11px] font-normal text-ink-soft">checked {checkedAt}</span>}
          </div>
        )}
      </div>
      {res && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-soft">
            {res.paypal.available ? (
              <>
                <span>{res.paypal.count} PayPal transactions</span>
                <span>report refreshed {res.paypal.lastRefreshed ?? "—"}</span>
                <span className={flagged ? "font-bold text-diff" : "text-ok"}>{flagged ? `${flagged} to review` : "no mismatches"}</span>
              </>
            ) : (
              <span className="text-diff">PayPal report unavailable — {res.paypal.reason}</span>
            )}
            {res.paypal.debugId && <span>debug-id {res.paypal.debugId}</span>}
          </div>
          {res.rows.length > 0 ? (
            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                <AgGridReact<LedgerRow>
                  theme={fcTheme}
                  rowData={res.rows}
                  columnDefs={cols}
                  getRowId={(r) => r.data.key}
                  domLayout="autoHeight"
                  rowHeight={44}
                  defaultColDef={{ suppressHeaderMenuButton: true, sortable: true }}
                />
              </div>
            </div>
          ) : (
            <div className="text-sm text-ink-soft">No captures or refunds yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
