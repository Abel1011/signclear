"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, ICellRendererParams } from "ag-grid-community";
import { registerAgGrid, fcTheme } from "./agGrid";
import { usd, type CaseView } from "./useCase";
import { Bell, Banner, Logo, Stamp, Refusal } from "./Bits";
import { plainCondition } from "@/lib/i18n";
import { LedgerGrid } from "./LedgerGrid";
import { preparerText } from "./preparerFindings";

registerAgGrid();

export type DeskCase = { name: string; client: string; preparer: string };
type CaseRow = { i: number; client: string; review: string; payment: string; amount: number; due: string; next: string; state: string };

const NEXT: Record<string, string> = {
  CASE_CREATED: "Send the link to the client",
  CONSENTED: "Upload the return (PDF)",
  CLARIFY: "Answer the client's question",
  DIFFERENCES: "Fix the return and re-upload",
  MATCH: "Waiting for client approval",
  AUTHORIZED: "File with the IRS",
  TRANSMITTED: "Upload IRS confirmation",
  REFUND_PROPOSED: "Respond within 72 h",
  UNRESOLVED: "SignClear is reviewing your evidence",
  PROCESSING: "Clara is reading the return…",
  CAPTURED: "Paid — nothing to do",
  CLOSED: "Closed — paid in full",
  INVESTIGATING: "Client's refund under review",
  REFUND_PENDING: "Refunding the fee…",
  REFUNDED: "Fee refunded — closed",
  VOID_PENDING: "Releasing the hold…",
  VOIDED: "Hold released — closed",
};
const nextFor = (c: CaseView) => (c.state === "REFUND_PROPOSED" && (c.preparerVerdict || c.refundWindowOpen === false) ? "Window closed — waiting on the client" : NEXT[c.state] ?? "—");
/** The IRS-confirmation deadline only matters while the fee is on hold; afterwards show the outcome. */
const dueFor = (c: CaseView) => {
  const st = c.payment?.status;
  if (st === "COMPLETED") return "Paid ✓ (IRS accepted)";
  if (st === "REFUNDED") return "Fee refunded";
  if (st === "VOIDED") return "Hold released";
  if (c.ackDeadline && ["AUTHORIZED", "TRANSMITTED"].includes(c.state)) return new Date(c.ackDeadline).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return "—";
};
const SOFT_NEXT = /^(Waiting|Client|Paid|Closed|Fee refunded|Hold released|Window closed|Refunding|Releasing|SignClear|Clara)/;
const REVIEW: Record<string, string> = {
  CASE_CREATED: "Link sent",
  CONSENTED: "Interview answered",
  PROCESSING: "AI reading the return…",
  MATCH: "Client reviewing",
  CLARIFY: "Client clarifying",
  DIFFERENCES: "Differences found",
  AUTHORIZED: "Approved by client",
  TRANSMITTED: "Filed — waiting on IRS",
  CAPTURED: "Accepted by IRS",
  INVESTIGATING: "Refund investigation",
  REFUND_PROPOSED: "Fee refund proposed",
  REFUND_PENDING: "Refunding…",
  REFUNDED: "Fee refunded",
  VOID_PENDING: "Cancelling hold…",
  VOIDED: "Hold cancelled",
  UNRESOLVED: "Human review",
  CLOSED: "Closed",
};
const SAMPLE: Record<string, string> = { maria: "/samples/maria-1040-TY2025-SAMPLE.pdf", carlos: "/samples/carlos-1040-TY2025-SAMPLE.pdf" };
const sampleFor = (name: string) => (/carlos/i.test(name) ? SAMPLE.carlos : SAMPLE.maria);

/** Polls every case on the desk. */
function useCases(tokens: string[]) {
  const [data, setData] = useState<(CaseView | null)[]>([]);
  const key = tokens.join(",");
  const refresh = useCallback(async () => {
    const out = await Promise.all(
      tokens.map((t) =>
        fetch(`/api/case/${t}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ),
    );
    setData(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  const act = useCallback(
    async (i: number, type: string, extra: Record<string, unknown> = {}) => {
      const r = await fetch(`/api/case/${tokens[i]}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...extra }) });
      const j = await r.json().catch(() => ({}));
      await refresh();
      return j as Record<string, unknown>;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, refresh],
  );
  return { data, act };
}

export function PreparerPanel({
  tokens,
  cases,
  onNewCase,
  onOpenClient,
}: {
  tokens?: string[];
  cases?: DeskCase[];
  onNewCase?: (c: DeskCase) => void;
  onOpenClient?: (c: DeskCase) => void;
}) {
  const prepTokens = cases ? cases.map((c) => c.preparer) : (tokens ?? []);
  const { data, act } = useCases(prepTokens);
  const apiRef = useRef<GridApi<CaseRow> | null>(null);
  const [sel, setSel] = useState(Math.max(0, prepTokens.length - 1));
  const [creating, setCreating] = useState(prepTokens.length === 0);
  useEffect(() => setSel(Math.max(0, prepTokens.length - 1)), [prepTokens.length]);
  const sig = data.map((c) => `${c?.state}|${c?.payment?.status}|${c?.refundWindowOpen}|${c?.preparerVerdict}`).join(",");
  const rows: CaseRow[] = useMemo(
    () =>
      data
        .map((c, i) =>
          c
            ? {
                i,
                client: c.clientName,
                review: REVIEW[c.state] ?? c.state,
                payment: c.payment?.status ?? "NONE",
                amount: c.fee,
                due: dueFor(c),
                next: nextFor(c),
                state: c.state,
              }
            : null,
        )
        .filter(Boolean) as CaseRow[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig, data.length],
  );
  const prev = useRef("");
  useEffect(() => {
    const s = rows.map((r) => r.payment).join("|");
    if (prev.current && prev.current !== s) apiRef.current?.flashCells({ columns: ["payment"], flashDuration: 1500, fadeDuration: 800 });
    prev.current = s;
  }, [rows]);

  const cols: ColDef<CaseRow>[] = [
    { field: "client", headerName: "Client", flex: 1.3, cellClass: "font-semibold" },
    { field: "review", headerName: "Status", flex: 1.3 },
    { field: "payment", headerName: "PayPal", flex: 1, cellRenderer: (p: ICellRendererParams<CaseRow>) => <Stamp status={p.value} small /> },
    { field: "amount", headerName: "Fee", flex: 0.7, valueFormatter: (p) => usd(p.value), cellClass: "font-mono" },
    { field: "due", headerName: "IRS confirmation due", flex: 1 },
    {
      field: "next",
      headerName: "Your next step",
      flex: 1.5,
      cellRenderer: (p: ICellRendererParams<CaseRow>) =>
        p.value === "—" || SOFT_NEXT.test(String(p.value)) ?<span className="text-ink-soft">{p.value}</span> : <span className="font-semibold text-ink underline decoration-mark decoration-4 underline-offset-2">{p.value} →</span>,
    },
  ];
  const totals = useMemo(() => {
    const sum = (st: string) => data.filter((c) => c?.payment?.status === st).reduce((a, c) => a + (c?.fee ?? 0), 0);
    return { held: sum("AUTHORIZED"), col: sum("COMPLETED"), ref: sum("REFUNDED") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const v = data[sel];
  const p = data.find(Boolean)?.preparer ?? { name: "Luis Pérez", business: "Pérez Tax Prep", ptin: "P01234567", efin: "123456" };
  return (
    <div className="min-h-full">
      <header className="border-b-[1.5px] border-ink bg-paper">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
          <Logo sub="Preparer desk" />
          <div className="order-3 flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft sm:order-none sm:ml-auto sm:w-auto sm:text-sm">
            <span className="font-semibold text-ink">{p.business}</span>
            <span className="font-mono">PTIN {p.ptin}</span>
            <span className="font-mono">EFIN {p.efin}</span>
            <span className="rounded-sm border border-ink px-2 py-0.5 text-xs font-semibold text-ink">PayPal connected</span>
            <a href="/connect" className="rounded-sm bg-ink px-2 py-0.5 text-xs font-semibold text-paper hover:opacity-90">Connect AI agent</a>
          </div>
          {v && <Bell items={v.notifications} lang="en" onOpen={() => act(sel, "mark_read")} />}
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] space-y-6 px-4 py-5 sm:px-8 sm:py-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="eyebrow">Tax season 2026</div>
            <h1 className="font-display text-4xl sm:text-5xl">
              Good morning, <em>{p.name.split(" ")[0]}</em>
            </h1>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {(
              [
                ["Held by PayPal", totals.held],
                ["Collected", totals.col],
                ["Refunded", totals.ref],
              ] as const
            ).map(([k, n]) => (
              <div key={k} className="card px-3 py-3 sm:min-w-40 sm:px-5">
                <div className="eyebrow">{k}</div>
                <div className="mt-0.5 font-mono text-lg font-semibold sm:text-2xl">{usd(n)}</div>
              </div>
            ))}
          </div>
        </div>
        {onNewCase && (creating ? <NewCase count={prepTokens.length} onCancel={prepTokens.length ? () => setCreating(false) : undefined} onCreated={(c) => (setCreating(false), onNewCase(c))} /> : (
          <button onClick={() => setCreating(true)} className="btn-primary">+ New client case</button>
        ))}
        {v && <CaseActions key={sel} v={v} act={(t, e) => act(sel, t, e)} desk={cases?.[sel]} onOpenClient={onOpenClient} />}
        <PayPalPanel cases={data} />
        {rows.length > 0 && (
          <div className="card overflow-x-auto">
            <div className="min-w-[760px]">
              <AgGridReact<CaseRow>
                theme={fcTheme}
                rowData={rows}
                columnDefs={cols}
                getRowId={(r) => String(r.data.i)}
                domLayout="autoHeight"
                rowHeight={56}
                defaultColDef={{ enableCellChangeFlash: true, suppressHeaderMenuButton: true, sortable: false }}
                onGridReady={(e) => (apiRef.current = e.api)}
                onRowClicked={(e) => e.data && setSel(e.data.i)}
                rowClass="cursor-pointer"
                getRowClass={(r) => (r.data?.i === sel ? "fc-row-selected" : "")}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/** Luis's view of PayPal: where his money is, the PayPal ID behind every move, disputes and the ledger. */
type PPDepth = {
  caseId: string;
  state: string;
  stateFee: number;
  stateSubmissionId: string | null;
  stateAckReceivedAt: string | null;
  lines: { kind: string; amount: number; platformFee: number; status: string; captureId: string | null; refundId: string | null }[];
  disputes: { disputeId: string; reason: string | null; status: string | null; stage: string | null; amount: number | null; sellerResponseDue: string | null; outcome: string | null; evidenceSubmittedAt: string | null; claimAcceptedAt: string | null; actions: ("provide_evidence" | "accept_claim")[] }[];
  onboarding: { multiparty: boolean; merchantId: string | null; onboardedAt: string | null };
  platformFee: number;
};

function PayPalPanel({ cases }: { cases: (CaseView | null)[] }) {
  const all = cases.filter((c): c is CaseView => !!c);
  const tokens = all.map((c) => c.tokens?.preparer).filter((t): t is string => !!t);
  const tkey = tokens.join(",");
  const [depth, setDepth] = useState<Record<string, PPDepth>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState("");
  const refresh = useCallback(async () => {
    const out: Record<string, PPDepth> = {};
    await Promise.all(
      tkey.split(",").filter(Boolean).map(async (t) => {
        const r = await fetch(`/api/preparer/${t}/paypal`, { cache: "no-store" }).catch(() => null);
        if (r?.ok) out[t] = await r.json();
      }),
    );
    setDepth(out);
  }, [tkey]);
  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 4000);
    return () => clearInterval(i);
  }, [refresh]);
  const post = async (t: string, body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/preparer/${t}/paypal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (j.url) window.location.href = j.url;
    else if (j.blocked)
      setMsg(`Not allowed yet: ${(j.blocked as string[]).map((b) => { const x = plainCondition(b, { prep: all[0]?.preparer.name ?? "", client: all[0]?.clientName ?? "" }); return `${x.text.en}${x.tag ? ` [${x.tag}]` : ""}`; }).join(" · ")}${j.debugId ? ` (PayPal debug-id ${j.debugId})` : ""}`);
    else if (j.error) setMsg(j.error);
    else if (body.action === "poll_disputes") setMsg(j.ok ? `PayPal disputes checked: ${j.total ?? 0} found, ${j.synced} updated (debug-id ${j.debugId}).` : `PayPal disputes unavailable (HTTP ${j.status}, debug-id ${j.debugId}).`);
    refresh();
    return j;
  };
  const first = tokens[0];
  const ob = first ? depth[first]?.onboarding : undefined;
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow">Getting paid · PayPal</div>
          <div className="mt-1 text-sm text-ink-soft">
            {ob?.merchantId ? (
              <>Fees go to <b className="text-ink">your own PayPal business account</b> (merchant {ob.merchantId}); SignClear keeps a {usd(depth[first!]?.platformFee ?? 400)} platform fee per return.</>
            ) : (
              <>Fees go to <b className="text-ink">the SignClear PayPal account</b> on your behalf.</>
            )}{" "}
            When a client approves, PayPal <b className="text-ink">holds</b> the fee; the federal part is <b className="text-ink">collected</b> when the IRS accepts and the state part when the state accepts; <b className="text-ink">released</b> if you don&apos;t file in time; <b className="text-ink">refunded</b> if the client&apos;s refund was diverted.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ob?.multiparty && !ob.merchantId && first && (
            <button disabled={busy} onClick={() => post(first, { action: "connect" })} className="btn-primary py-1.5 text-sm">
              Connect PayPal
            </button>
          )}
          <span className="rounded-sm border-[1.5px] border-ink px-2 py-1 font-mono text-xs font-bold">{ob?.merchantId ? "PayPal · your account" : "PayPal · connected"}</span>
          {first && (
            <button disabled={busy} onClick={() => post(first, { action: "poll_disputes" })} className="btn-secondary py-1.5 text-xs">
              Check disputes
            </button>
          )}
        </div>
      </div>
      {all.length > 0 && (
        <div className="mt-4 space-y-1.5 text-xs">
          {all.map((c) => {
            const t = c.tokens?.preparer ?? "";
            const d = depth[t];
            const st = d?.lines.find((l) => l.kind === "STATE");
            const fed = d?.lines.find((l) => l.kind === "FEDERAL");
            const preApproval = ["CASE_CREATED", "CONSENTED", "CLARIFY", "DIFFERENCES", "MATCH"].includes(c.state) && !c.payment?.authorizationId;
            if (!c.payment && !preApproval) return null;
            return (
              <div key={t || c.id} className="space-y-1 border-t border-dashed border-ink/20 pt-1.5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono">
                  <span className="w-32 truncate font-sans text-sm font-semibold">{c.clientName}</span>
                  {c.payment && c.payment.status !== "NONE" && <Stamp status={c.payment.status} small />}
                  {c.payment?.authorizationId && <span>auth {c.payment.authorizationId}</span>}
                  {(d?.lines.length ? d.lines : []).map((l) => (
                    <span key={l.kind} className="rounded-sm border border-ink/30 px-1.5">
                      {l.kind.toLowerCase()} {usd(l.amount)} · {l.status.toLowerCase().replace(/_/g, " ")}
                      {l.captureId && ` · capture ${l.captureId}`}
                      {l.platformFee > 0 && ` · fee ${usd(l.platformFee)}`}
                      {l.refundId && ` · refund ${l.refundId}`}
                    </span>
                  ))}
                  {!d?.lines.length && c.payment?.captureId && <span>capture {c.payment.captureId}</span>}
                  {!d?.lines.length && c.payment?.refundId && <span>refund {c.payment.refundId}</span>}
                </div>
                {preApproval && d && (
                  <div className="flex flex-wrap items-center gap-2 font-sans">
                    <span className="text-ink-soft">
                      Fee {usd(c.fee)} = federal {usd(c.fee - d.stateFee)}
                      {d.stateFee > 0 && <> + state {usd(d.stateFee)}</>}
                    </span>
                    <input value={split} onChange={(e) => setSplit(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="state part $" className="w-24 rounded-md border-[1.5px] border-ink/25 bg-white px-2 py-1 font-mono outline-none focus:border-ink" />
                    <button disabled={busy || !split} onClick={() => post(t, { action: "set_state_fee", stateCents: Math.round(Number(split) * 100) })} className="btn-secondary py-1 text-xs">
                      Split federal / state
                    </button>
                  </div>
                )}
                {st && st.status === "AUTHORIZED" && fed?.status === "COMPLETED" && (
                  <button disabled={busy} onClick={() => post(t, { action: "state_ack" })} className="btn-primary py-1.5 font-sans text-sm">
                    Upload state confirmation “Accepted” <span className="badge-sim">simulated</span>
                  </button>
                )}
                {d?.disputes.map((x) => (
                  <div key={x.disputeId} className="rounded-md border-[1.5px] border-diff bg-diff-soft px-3 py-2 font-sans text-sm">
                    <div className="flex flex-wrap items-center gap-x-3">
                      <b>PayPal dispute {x.disputeId}</b>
                      <span>{x.reason?.toLowerCase().replace(/_/g, " ")}</span>
                      <span className="font-mono text-xs">{x.status} · {x.stage}</span>
                      {x.amount != null && <span className="font-mono text-xs">{usd(x.amount)}</span>}
                      {x.sellerResponseDue && <span className="text-xs">respond by {new Date(x.sellerResponseDue).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
                    </div>
                    <div className="mt-1 text-xs text-ink-soft">Evidence package ready: approved return snapshot, 7216 consent, IRS acceptance and Submission ID {c.submissionId ?? "—"}.</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {x.actions.includes("provide_evidence") && !x.evidenceSubmittedAt && (
                        <button disabled={busy} onClick={() => post(t, { action: "provide_evidence", disputeId: x.disputeId })} className="btn-primary py-1 text-xs">
                          Send evidence to PayPal
                        </button>
                      )}
                      {x.actions.includes("accept_claim") && !x.claimAcceptedAt && (
                        <button disabled={busy} onClick={() => post(t, { action: "accept_claim", disputeId: x.disputeId })} className="btn-secondary py-1 text-xs">
                          Accept claim (refund client)
                        </button>
                      )}
                      {x.evidenceSubmittedAt && <span className="text-xs text-ok">Evidence sent.</span>}
                      {x.claimAcceptedAt && <span className="text-xs">Claim accepted.</span>}
                      {!x.actions.length && <span className="text-xs text-ink-soft">No action available from PayPal right now.</span>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {msg && <div className="mt-3 rounded-md border-[1.5px] border-ink/40 px-3 py-2 text-sm">{msg}</div>}
      <LedgerGrid tokens={tokens} />
    </div>
  );
}

function NewCase({ count, onCreated, onCancel }: { count: number; onCreated: (c: DeskCase) => void; onCancel?: () => void }) {
  const [name, setName] = useState(count === 0 ? "María González" : "Carlos Ruiz");
  const [lang, setLang] = useState(count === 0 ? "es" : "en");
  const [fee, setFee] = useState("250");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const field = "mt-1 w-full rounded-md border-[1.5px] border-ink/25 bg-white px-3 py-2 text-[15px] outline-none focus:border-ink";
  return (
    <form
      className="card grid gap-4 p-5 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end sm:p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const r = await fetch("/api/desk/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientName: name, lang, fee: Number(fee) }) });
        const j = await r.json();
        setBusy(false);
        if (!r.ok) return setErr(j.error ?? "error");
        onCreated(j as DeskCase);
      }}
    >
      <div className="sm:col-span-4">
        <div className="font-display text-2xl">New client case</div>
        <div className="text-sm text-ink-soft">Your client gets a private link to answer a short interview and review the return before paying you.</div>
      </div>
      <label>
        <span className="eyebrow">Client name</span>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span className="eyebrow">Client language</span>
        <select className={field} value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="es">Español</option>
          <option value="en">English</option>
          <option value="pt">Português</option>
        </select>
      </label>
      <label>
        <span className="eyebrow">Your fee (USD)</span>
        <input className={field + " font-mono"} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <button disabled={busy} className="btn-primary">{busy ? "Creating…" : "Create case"}</button>
        {onCancel && <button type="button" onClick={onCancel} className="btn-secondary">Cancel</button>}
      </div>
      {err && <div className="text-sm text-diff sm:col-span-4">{err}</div>}
      <div className="text-xs text-ink-soft sm:col-span-4">Sample returns are available for “María González” and “Carlos Ruiz”.</div>
    </form>
  );
}

function CaseActions({ v, act, desk, onOpenClient }: { v: CaseView; act: (t: string, e?: Record<string, unknown>) => Promise<Record<string, unknown>>; desk?: DeskCase; onOpenClient?: (c: DeskCase) => void }) {
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState("");
  const [answer, setAnswer] = useState("");
  const [sid, setSid] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ackFile, setAckFile] = useState<File | null>(null);
  const [busyText, setBusyText] = useState("");
  const [last, setLast] = useState<{ ok: boolean; text: string; blocked?: string[] } | null>(null);
  const run = async (t: string, e?: Record<string, unknown>, label = "") => {
    setBusy(true);
    setBusyText(label);
    setLast(null);
    const r = await act(t, e);
    const b = (r as { blocked?: string[] })?.blocked;
    const err = (r as { error?: string })?.error;
    const msg = (r as { message?: string })?.message;
    const rejected = (r as { verdict?: string })?.verdict === "REJECTED_BY_IRS";
    if (msg) setLast({ ok: !!(r as { ok?: boolean }).ok, text: msg, blocked: b?.length && !rejected ? b : undefined });
    else if (b) setLast({ ok: false, text: t === "request_capture" ? "PayPal did not collect the fee:" : "Not allowed yet:", blocked: b });
    else if (err) setLast({ ok: false, text: err });
    setBusy(false);
    setBusyText("");
  };
  const b64 = async (f: File) => {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const uploadAck = async () => {
    if (!ackFile) return;
    await run("upload_ack", { file: { base64: await b64(ackFile), mediaType: ackFile.type || "application/pdf", name: ackFile.name } }, "Clara is reading the acknowledgment…");
  };
  const retransmit = v.state === "TRANSMITTED" && v.lastAck?.verdict === "REJECTED_BY_IRS" && v.lastAck.read.submission_id === v.submissionId;
  const upload = async (f?: File) => {
    const pick = f ?? file;
    if (!pick) return;
    const buf = new Uint8Array(await pick.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await run("upload_draft", { file: { base64: btoa(bin), mediaType: pick.type || "application/pdf" } });
  };
  const link = desk && typeof window !== "undefined" ? `${window.location.origin}/c/${desk.client}` : null;
  /** The client's questions need an answer only while her review is still open. */
  const qOpen = ["CLARIFY", "DIFFERENCES", "NEEDS_CONFIRMATION"].includes(v.state);
  const pay = v.payment;
  const status: Record<string, string> = {
    PROCESSING: "Clara is reading the return…",
    CLARIFY: `${v.clientName.split(" ")[0]} is reviewing a difference. If she sends you questions, they appear here.`,
    MATCH: `Everything matches. Waiting for ${v.clientName.split(" ")[0]} to approve — PayPal will hold your fee, not charge it.`,
    UNRESOLVED: "You submitted evidence. A person at SignClear reviews it; the fee stays collected meanwhile.",
    CAPTURE_PENDING: "PayPal is collecting your fee…",
    CAPTURED: `Paid ✓ PayPal collected ${usd(pay?.amount ?? v.fee)}${pay?.captureId ? ` (capture ${pay.captureId})` : ""} after the IRS accepted the return. Nothing left for you to do.`,
    CLOSED: `Closed ✓ You were paid ${usd(pay?.amount ?? v.fee)} and ${v.clientName.split(" ")[0]}'s refund arrived in full.`,
    INVESTIGATING: `Paid ✓ — but ${v.clientName.split(" ")[0]}'s refund arrived ${usd((v.approvedRefund ?? 0) - (v.reportedRefund ?? 0))} short. Clara is checking her IRS transcript; your fee stays collected meanwhile.`,
    REFUND_PROPOSED: v.preparerVerdict === "INCONCLUSIVE" ? "Your reply was recorded but doesn't explain where the money went. The client can confirm the fee refund when the 72 h end." : "Your 72 h window to respond is closed. The fee is refunded to the client when she confirms.",
    REFUND_PENDING: "PayPal is refunding the fee to the client…",
    REFUNDED: `Closed — your ${usd(pay?.amount ?? v.fee)} fee was refunded to the client through PayPal${pay?.refundId ? ` (refund ${pay.refundId})` : ""}.`,
    VOID_PENDING: "PayPal is releasing the hold…",
    VOIDED: "Closed — the hold was released because the return wasn't confirmed by the IRS in time. Nothing was charged.",
  };
  return (
    <div className="card space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow">Selected case</div>
          <div className="font-display text-3xl">{v.clientName}</div>
        </div>
        {v.submissionId && (
          <div className="text-xs text-ink-soft">
            Submission ID <span className="font-mono text-ink">{v.submissionId}</span>
          </div>
        )}
      </div>
      {link && v.state === "CASE_CREATED" && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border-[1.5px] border-dashed border-ink/40 bg-paper px-4 py-3 text-sm">
          <span className="text-ink-soft">Client link:</span>
          <a href={link} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs underline">{link}</a>
          <button onClick={() => navigator.clipboard?.writeText(link)} className="btn-secondary py-1.5 text-sm">Copy</button>
          {onOpenClient && desk && (
            <button onClick={() => onOpenClient(desk)} className="btn-primary py-1.5 text-sm">
              Open as {v.clientName.split(" ")[0]} →
            </button>
          )}
        </div>
      )}
      {v.findings.length > 0 && (
        <div className="space-y-1.5">
          {v.findings.map((f, i) => (
            <div key={i} className="rounded-md bg-paper px-3 py-2 text-sm text-ink">
              <span className="mr-2 rounded-sm bg-mark px-1.5 font-mono text-[11px] font-bold">{f.severity === "CLARIFY" ? "CLIENT ASKS" : f.rule === "R14" ? "AFTER FILING" : "DIFFERENCE"}</span>
              {preparerText(f)}
              <span className="ml-2 font-mono text-[10px] text-ink-soft">rule {f.rule}</span>
            </div>
          ))}
        </div>
      )}
      {v.chat.some((m) => m.text.startsWith("__QUESTIONS_SENT__")) && (
        <div className={`rounded-md border-[1.5px] p-4 text-sm ${qOpen ? "border-ink bg-mark/30" : "border-ink/25 bg-paper text-ink-soft"}`}>
          <div className="flex flex-wrap items-center gap-2 font-semibold">
            {v.clientName.split(" ")[0]} {qOpen ? "asks you:" : "asked you:"}
            {!qOpen && <span className="rounded-sm border border-ok px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-ok">✓ Resolved</span>}
          </div>
          {v.chat
            .filter((m) => m.text.startsWith("__QUESTIONS_SENT__"))
            .flatMap((m) => JSON.parse(m.text.slice(18)) as string[])
            .map((q, i) => (
              <div key={i} className="mt-1">• {q}</div>
            ))}
          {v.chat.filter((m) => m.role === "preparer").map((m) => (
            <div key={m.id} className="mt-2 border-l-[3px] border-ink pl-2 text-ink-soft">You: {m.text}</div>
          ))}
          {!qOpen && (
            <div className="mt-2 text-xs">
              {v.confirmed
                ? `${v.clientName.split(" ")[0]} confirmed the answer and approved the review. No reply needed.`
                : "Clara re-checked the corrected return and nothing differs any more. No reply needed."}
            </div>
          )}
          {qOpen && <>
          <div className="mt-3 flex gap-2">
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={`Reply to ${v.clientName.split(" ")[0]}…`} className="flex-1 rounded-md border-[1.5px] border-ink/25 bg-white px-3 py-2 outline-none focus-visible:border-ink" />
            <button disabled={busy || !answer.trim()} onClick={async () => { await run("reply_client", { text: answer }); setAnswer(""); }} className="btn-primary py-2 text-sm">
              Reply
            </button>
          </div>
          {v.findings.some((f) => f.rule === "R5") && <button type="button" onClick={() =>
              setAnswer(
                ({
                  es: "Su sobrino vivió 5 meses con usted, así que no cumple la prueba de residencia de hijo calificado; como pariente calificado, usted tendría que haber pagado más de la mitad de su manutención. Si fue así, dígamelo y lo reviso.",
                  pt: "Seu sobrinho morou 5 meses com você, então não cumpre o teste de residência de filho qualificado; como parente qualificado, você teria que ter pago mais da metade do sustento dele. Se foi assim, me avise e eu reviso.",
                } as Record<string, string>)[v.lang] ??
                  "Your nephew lived with you 5 months, so he doesn't meet the residency test for a qualifying child; as a qualifying relative you'd need to have provided more than half his support. If you did, tell me and I'll review it.",
              )
            } className="mt-1 text-xs text-ink-soft underline">
            example reply
          </button>}
          </>}
        </div>
      )}
      {v.intakeChanges > 0 && <Banner tone="info">The client updated {v.intakeChanges} answer(s) after seeing the return (logged).</Banner>}
      <div className="flex flex-wrap items-center gap-3">
        {["CONSENTED", "DIFFERENCES"].includes(v.state) && (
          <>
            <label className="btn-secondary cursor-pointer">
              <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {file ? file.name : "Choose the return (PDF)…"}
            </label>
            <button disabled={busy || !file} onClick={() => upload()} className="btn-primary">
              {busy ? "Clara is reading it…" : "Upload the return"}
            </button>
            <span className="text-sm text-ink-soft">or</span>
            <button
              disabled={busy}
              onClick={async () => {
                const b = await (await fetch(sampleFor(v.clientName))).blob();
                const f = new File([b], sampleFor(v.clientName).split("/").pop()!, { type: "application/pdf" });
                setFile(f);
                await upload(f);
              }}
              className="btn-secondary"
            >
              Use the sample return
            </button>
            <a href={sampleFor(v.clientName)} target="_blank" rel="noreferrer" className="text-xs text-ink-soft underline underline-offset-2">
              view it
            </a>
          </>
        )}
        {(v.state === "AUTHORIZED" || retransmit) && (
          <>
            {retransmit && <span className="w-full text-sm font-semibold text-diff">The IRS rejected {v.submissionId}. Correct the return, retransmit, and record the new Submission ID before the deadline.</span>}
            <input value={sid} onChange={(e) => setSid(e.target.value.trim())} maxLength={20} placeholder={`IRS Submission ID · EFIN ${v.preparer.efin} + year + day + 7 chars`} className="w-[min(420px,100%)] rounded-md border-[1.5px] border-ink/25 bg-white px-3 py-2.5 font-mono text-sm outline-none focus:border-ink" />
            <button type="button" onClick={() => {
                const d = new Date();
                const doy = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400_000);
                setSid(`${v.preparer.efin}${d.getFullYear()}${String(doy).padStart(3, "0")}${Math.random().toString(36).slice(2, 9).padEnd(7, "0")}`);
              }} className="text-xs font-semibold text-ink-soft underline">
              generate one
            </button>
            {sid.length > 0 && sid.length !== 20 && <span className="font-mono text-xs text-diff">{sid.length}/20 characters</span>}
            <button disabled={busy || sid.length !== 20} onClick={() => run("register_transmission", { submissionId: sid })} className="btn-primary">
              {retransmit ? "Record the retransmission" : "Record e-file with the IRS"}
            </button>
          </>
        )}
        {v.state === "TRANSMITTED" && (
          <>
            <label className="btn-secondary cursor-pointer">
              <input type="file" accept="application/pdf,image/png,image/jpeg" className="hidden" onChange={(e) => setAckFile(e.target.files?.[0] ?? null)} />
              {ackFile ? ackFile.name : "Choose the IRS acknowledgment (PDF)…"}
            </label>
            <button disabled={busy || !ackFile} onClick={() => uploadAck()} className="btn-primary">
              Upload acknowledgment
            </button>
            <span className="text-sm text-ink-soft">or</span>
            <button disabled={busy} onClick={() => run("upload_ack", { sample: true }, "Clara is reading the sample acknowledgment…")} className="btn-secondary" title="Renders the acknowledgment report for this case's Submission ID and reads it with the real reader">
              Use sample acknowledgment <span className="badge-sim">sandbox</span>
            </button>
            <button type="button" disabled={busy} onClick={() => run("upload_ack", { sample: "rejected" }, "Clara is reading the sample rejection…")} className="text-xs text-ink-soft underline">
              sample rejection
            </button>
            <button disabled={busy} onClick={() => run("request_capture", undefined, "Asking PayPal…")} className="btn-danger">
              Ask to be paid now
            </button>
          </>
        )}
        {busy && busyText && <span className="w-full text-sm text-ink-soft" role="status">{busyText}</span>}
        {v.state === "REFUND_PROPOSED" && !v.preparerVerdict && v.refundWindowOpen !== false && (
          <div className="flex w-full gap-2">
            <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Respond with evidence (e.g. your filed copy)…" className="flex-1 rounded-md border-[1.5px] border-ink/25 bg-white px-3.5 py-2.5 text-sm outline-none" />
            <button disabled={busy || !reply.trim()} onClick={() => run("respond", { text: reply })} className="btn-secondary">
              Respond
            </button>
          </div>
        )}
        {!["CASE_CREATED", "CONSENTED", "DIFFERENCES", "AUTHORIZED", "TRANSMITTED"].includes(v.state) && !(v.state === "REFUND_PROPOSED" && !v.preparerVerdict && v.refundWindowOpen !== false) && (
          <span className={`text-sm ${["CAPTURED", "CLOSED"].includes(v.state) ? "font-semibold text-ok" : "text-ink-soft"}`}>
            {status[v.state] ?? "Nothing for you to do right now — waiting on the client or the IRS."}
          </span>
        )}
        {v.state === "REFUND_PROPOSED" && !v.preparerVerdict && v.refundWindowOpen !== false && v.refundDeadline && (
          <span className="w-full text-xs text-ink-soft">
            Respond by {new Date(v.refundDeadline).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (simulated clock).
            {v.diversion && ` The IRS record shows the filed Form 8888 sent ${usd(v.diversion.amount)} to ****${v.diversion.acct}; the approved return had no such split.`}
          </span>
        )}
      </div>
      {last && (
        <div className={`rounded-md border-[1.5px] px-4 py-3 text-sm ${last.ok ? "border-ok text-ok" : "border-diff bg-diff-soft text-ink"}`}>
          {last.text}
          {last.blocked?.length ? (
            <div className="mt-1 font-semibold">
              <Refusal conditions={last.blocked} lang="en" prep={v.preparer.name} client={v.clientName} />
            </div>
          ) : null}
        </div>
      )}
      {v.lastAck && <AckRead a={v.lastAck} />}
    </div>
  );
}

/** What Clara read from the last IRS acknowledgment, and which code checks passed or failed. */
function AckRead({ a }: { a: NonNullable<CaseView["lastAck"]> }) {
  const r = a.read;
  const rows: [string, string][] = [
    ["Status", r.status],
    ["Submission ID", r.submission_id ?? "—"],
    ["EFIN", r.efin ?? "—"],
    ["Taxpayer", `${r.taxpayer_name ?? "—"}${r.ssn_last4 ? ` · SSN ****${r.ssn_last4}` : ""}`],
    ["Tax year", r.tax_year ? String(r.tax_year) : "—"],
    ["Acknowledged", r.ack_date ?? "—"],
  ];
  const head = a.verdict === "ACCEPTED" ? "IRS acceptance verified" : a.verdict === "REJECTED_BY_IRS" ? "Rejected by the IRS — correct and retransmit" : "Acknowledgment refused";
  return (
    <div className="rounded-md border-[1.5px] border-ink/20 bg-paper p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className={`font-semibold ${a.verdict === "ACCEPTED" ? "text-ok" : "text-diff"}`}>{head}</div>
        <div className="font-mono text-[11px] text-ink-soft">What Clara read{a.mode === "cached" ? " (read live by Claude on first upload of this exact file; replayed instantly)" : ""}</div>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        {rows.map(([k, val]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-ink/10 py-0.5">
            <dt className="text-ink-soft">{k}</dt>
            <dd className="text-right font-mono text-xs">{val}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-3 space-y-0.5">
        {a.checks.map((c) => (
          <li key={c.id} className={c.ok ? "text-ink" : "font-semibold text-diff"}>
            <span aria-hidden className="mr-1.5 font-mono">{c.ok ? "✓" : "✗"}</span>
            {c.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
