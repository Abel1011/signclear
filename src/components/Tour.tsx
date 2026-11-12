"use client";
// "Watch SignClear in 90 seconds": auto-plays the real story on one real case (real engine, real PayPal sandbox).
// The server advances one deterministic step at a time (/api/tour); Clara's explanations arrive on their own.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ClientApp } from "./ClientApp";
import { PreparerPanel, type DeskCase } from "./PreparerPanel";
import { useCase, usd, type AuditRow } from "./useCase";
import { TOUR_STEPS, type TourScreen } from "@/lib/tour-steps";
import { paypalCall, type PayPalCall } from "@/lib/paypal-calls";
import { fetchJsonRetry } from "@/lib/fetch-retry";

const N = TOUR_STEPS.length;
/** How long each caption stays before the next step runs (ms). ~10 steps ≈ 90 s with the calls themselves. */
export const dwellFor = (i: number) => (i === 0 ? 7000 : TOUR_STEPS[i]?.paypal ? 8500 : 6500);

type StepRes = { ok: boolean; state: string; already?: boolean; blocked?: string[]; position: number; error?: string };
type Tick = { id: string; at: string; guardian: boolean; call: PayPalCall | null; conditions: string[] };

const JSON_POST = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export function Tour({ onExit, onTryIt }: { onExit: () => void; onTryIt: () => void }) {
  const [kase, setKase] = useState<DeskCase | null>(null);
  const [pos, setPos] = useState(0); // next step to run (N = finished)
  const [shown, setShown] = useState(0); // step whose caption is on screen
  const startedAt = useRef(Date.now());
  const [playing, setPlaying] = useState(true);
  const [closedFinale, setClosedFinale] = useState(false);
  const playingRef = useRef(true);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  const [manual, setManual] = useState(false);
  const manualRef = useRef(false);
  useEffect(() => {
    manualRef.current = manual;
  }, [manual]);
  const [running, setRunning] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [view, setView] = useState<TourScreen>("client");
  const [startErr, setStartErr] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const started = useRef(-1);

  const start = useCallback(async () => {
    setStartErr(null);
    setKase(null); startedAt.current = Date.now();
    try {
      const r = await fetchJsonRetry<{ case?: DeskCase; error?: string }>("/api/tour", JSON_POST({ action: "start" }), { timeoutMs: 40_000 });
      if (!r.ok || !r.json.case) throw new Error(r.json.error ?? "Could not start the story.");
      setKase(r.json.case);
      startedAt.current = Date.now();
      setPos(1);
      setShown(0);
      setNotes({});
      setErr(null);
      setTarget(null);
      setManual(false);
      setPlaying(true);
      setView("client");
    } catch (e) {
      setStartErr(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => {
    if (started.current === round) return;
    started.current = round;
    start();
  }, [start, round]);

  const run = useCallback(
    async (k: number) => {
      if (!kase) return;
      setRunning(k);
      setErr(null);
      setView(TOUR_STEPS[k].screen);
      try {
        const r = await fetchJsonRetry<StepRes>("/api/tour", JSON_POST({ action: "step", token: kase.preparer, step: k }), { timeoutMs: 55_000 });
        if (!r.ok) throw new Error(r.json.error ?? `Step failed (HTTP ${r.status}).`);
        const j = r.json;
        if (!j.ok && !j.already) throw new Error(`${TOUR_STEPS[k].title}: ${(j.blocked ?? []).join("; ") || `state ${j.state}`}`);
        if (j.blocked?.length) setNotes((n) => ({ ...n, [k]: j.blocked!.join(" · ") }));
        setShown(Math.min(k, j.position - 1));
        setPos(j.position);
      } catch (e) {
        setErr(String((e as Error).message ?? e));
        setPlaying(false);
        setTarget(null);
      } finally {
        setRunning(null);
      }
    },
    [kase],
  );

  const { data } = useCase(kase?.preparer ?? null, { audit: true, interval: 1500 });
  // Driver: auto-advance after the caption's dwell, or run straight through to a skip target.
  useEffect(() => {
    if (!kase || running !== null || err || pos >= N) return;
    if (target !== null) {
      if (pos > target) setTarget(null);
      else run(pos);
      return;
    }
    if (!playing || manual) return;
    // The AI is the point of the fraud moment: don't move on until Clara has spoken (or 20 s passed).
    const claraSpoke = (data?.chat ?? []).some((m) => m.role === "agent");
    const waitClara = shown === 0 && !claraSpoke && Date.now() - startedAt.current < 20_000;
    const t = setTimeout(() => {
      if (playingRef.current && !manualRef.current) run(pos); // Pause wins even if it lands during the dwell
    }, waitClara ? Math.max(dwellFor(shown), 20_000 - (Date.now() - startedAt.current)) : dwellFor(shown));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kase, running, err, pos, target, playing, manual, shown, run, (data?.chat ?? []).some((m) => m.role === "agent")]);

  // Judge drives: follow whatever they do on the screens.
  useEffect(() => {
    if (!kase || !manual) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/tour?token=${encodeURIComponent(kase.preparer)}`, { cache: "no-store" }).catch(() => null);
      const j = (await r?.json().catch(() => null)) as { position?: number } | null;
      if (j?.position && j.position > pos) {
        setPos(j.position);
        setShown(j.position - 1);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [kase, manual, pos]);

  const ticks: Tick[] = useMemo(
    () =>
      ((data?.audit ?? []) as AuditRow[])
        .filter((r) => r.actor === "paypal" || (r.actor === "guardian" && r.action === "capture_blocked"))
        .map((r) => ({
          id: r.id,
          at: new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          guardian: r.actor === "guardian",
          call: paypalCall(r, data?.payment),
          conditions: Array.isArray(r.detail?.conditions) ? (r.detail.conditions as string[]) : [],
        }))
        .reverse(),
    [data?.audit, data?.payment],
  );
  const latest = (kind: PayPalCall["objectKind"]) => ticks.find((t) => t.call?.objectKind === kind && t.call.objectId && t.call.debugId)?.call ?? null;

  const finished = !!kase && pos >= N && running === null;
  const cur = running ?? shown;
  const step = TOUR_STEPS[cur];
  const proof = !running && step?.paypal ? latest(step.id === "approve" ? "authorization" : step.id === "ack" ? "capture" : "refund") : null;

  if (!kase)
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink px-4 text-sheet">
        <div className="max-w-lg text-center">
          <div className="font-mono text-[11px] uppercase tracking-widest text-mark">SignClear in 90 seconds</div>
          {startErr ? (
            <>
              <div className="mt-3 font-display text-3xl">The story couldn&apos;t start.</div>
              <div className="mt-2 text-sm text-sheet/70">{startErr}</div>
              <div className="mt-5 flex justify-center gap-3">
                <button onClick={() => setRound((x) => x + 1)} className="btn-primary">
                  Try again
                </button>
                <button onClick={onExit} className="rounded-md border border-sheet/40 px-4 py-2 text-sm">
                  Back
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mt-3 font-display text-3xl">Preparing María&apos;s case…</div>
              <div className="mt-2 text-sm text-sheet/70">A fresh private sample case, built by the real engine. Every PayPal call that follows is a real sandbox call.</div>
            </>
          )}
        </div>
      </div>
    );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden" data-tour>
      <div className="shrink-0 bg-ink text-sheet">
        {/* Step rail: click a future step to skip ahead (the steps in between still run, fast). */}
        <div className="flex gap-px px-0">
          {TOUR_STEPS.map((s, i) => {
            const done = i < pos;
            const now = i === cur;
            return (
              <button
                key={s.id}
                title={done ? s.title : `Skip to: ${s.title}`}
                disabled={done || running !== null}
                onClick={() => setTarget(i)}
                data-tour-step={s.id}
                className={`h-2 flex-1 transition ${now ? "bg-mark" : done ? "bg-mark/60" : "bg-sheet/15 hover:bg-sheet/40"}`}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 basis-full lg:basis-0 lg:flex-1">
            {finished ? (
              <>
                <Finale ticks={ticks} latest={latest} fee={data?.fee} />
                {!closedFinale && (
                  <div className="fixed inset-0 z-50 grid place-items-center bg-ink/60 p-4 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && setClosedFinale(true)}>
                    <div className="w-full max-w-3xl rounded-md border-[1.5px] border-mark bg-ink p-6 text-sheet shadow-[6px_6px_0_0_var(--color-mark)]">
                      <Finale ticks={ticks} latest={latest} fee={data?.fee} />
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button onClick={onTryIt} className="btn-primary">Try it yourself →</button>
                        <button onClick={() => setClosedFinale(true)} className="rounded-md border-[1.5px] border-sheet/50 px-4 py-2 text-sm font-semibold">Look around the screens</button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-sheet/55">
                  <span className="font-bold text-mark">▶ SignClear in 90 seconds</span>
                  <span>
                    · Act {step.act} · {cur + 1}/{N}
                  </span>
                  <span className={`rounded-sm px-1.5 py-0.5 font-bold ${step.who === "Clock" ? "border border-sheet/40 text-sheet/80" : "bg-mark text-ink"}`}>{step.who}</span>
                  {manual && <span className="rounded-sm border border-mark px-1.5 py-0.5 text-mark">you&apos;re driving</span>}
                </div>
                <div className="mt-1 font-display text-2xl leading-tight sm:text-3xl" data-tour-title>
                  {step.title}
                </div>
                <div className="mt-1 max-w-4xl text-sm leading-snug text-sheet/75 sm:text-base">{step.caption}</div>
                {running !== null && (
                  <div className="mt-1.5 font-mono text-xs text-mark">
                    ⏳ running the real engine{step.paypal ? " and calling the PayPal sandbox" : ""}…
                  </div>
                )}
                {running === null && notes[cur] && (
                  <div className="mt-1.5 font-mono text-xs text-rose-300" data-tour-refused>
                    Refused by code: {notes[cur].replace(/^R\d+:\s*/, "").replace(/\("Accepted"\)\s*/, "")} <span className="text-sheet/40">(rule {notes[cur].match(/^R\d+/)?.[0] ?? "—"})</span>
                  </div>
                )}
                {proof && (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-xs text-sky-300" data-tour-proof>
                    <span>
                      PayPal {proof.objectKind} <b className="select-all text-sheet">{proof.objectId}</b>
                    </span>
                    <span>
                      Debug-ID <b className="select-all text-sheet">{proof.debugId}</b>
                    </span>
                  </div>
                )}
                {manual && pos < N && running === null && (
                  <div className="mt-2 text-sm text-mark">
                    Your move: {TOUR_STEPS[pos].manual.replace(/\.$/, "")}{" "}
                    <button onClick={() => run(pos)} className="ml-1 underline underline-offset-2">
                      — or let SignClear do it ▸
                    </button>
                  </div>
                )}
                {err && (
                  <div className="mt-2 text-sm text-rose-300">
                    {err}{" "}
                    <button onClick={() => (setErr(null), setPlaying(true))} className="ml-2 font-semibold text-mark underline">
                      Retry
                    </button>
                  </div>
                )}
              </>
            )}
            {/* Caption timer */}
            {!finished && !manual && playing && running === null && !err && (
              <div className="mt-2 h-0.5 w-full max-w-md bg-sheet/10">
                <div key={`${shown}-${pos}`} className="tour-dwell h-full bg-mark/70" style={{ animationDuration: `${dwellFor(shown)}ms` }} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {finished ? (
              <>
                <button onClick={onTryIt} className="btn-primary">
                  Try it yourself →
                </button>
                <button onClick={() => setRound((x) => x + 1)} className="rounded-md border-[1.5px] border-sheet/50 px-4 py-2 text-sm font-semibold">
                  ↻ Replay
                </button>
              </>
            ) : (
              <>
                {manual ? (
                  <button onClick={() => (setManual(false), setPlaying(true))} className="btn-primary" data-tour-resume>
                    ▶ Resume autoplay
                  </button>
                ) : (
                  <button onClick={() => setPlaying(!playing)} className="btn-primary min-w-[7.5rem]" data-tour-pause>
                    {playing ? "❚❚ Pause" : "▶ Resume"}
                  </button>
                )}
                <button
                  disabled={running !== null || pos >= N}
                  onClick={() => setTarget(pos)}
                  className="rounded-md border-[1.5px] border-sheet/50 px-3 py-2 text-sm font-semibold hover:bg-sheet/10 disabled:opacity-40"
                  data-tour-next
                >
                  Next ⏭
                </button>
                {!manual && (
                  <button onClick={() => (setManual(true), setPlaying(false))} className="rounded-md border-[1.5px] border-dashed border-sheet/50 px-3 py-2 text-sm hover:bg-sheet/10" data-tour-takeover>
                    Take over from here
                  </button>
                )}
              </>
            )}
            <button onClick={onExit} className="px-2 font-mono text-[11px] uppercase tracking-widest text-sheet/50 hover:text-sheet">
              Exit
            </button>
          </div>
        </div>
        {/* Latest PayPal call on small screens (the full ticker is on the right on wide screens). */}
        {ticks[0] && (
          <div className="border-t border-sheet/10 px-4 py-1.5 font-mono text-[11px] text-sky-300 lg:hidden">
            <TickLine t={ticks[0]} />
          </div>
        )}
        <div className="flex items-end gap-1 px-4 sm:px-6">
          {(["client", "desk"] as TourScreen[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-t-md border-x-[1.5px] border-t-[1.5px] px-3.5 py-1.5 text-sm ${view === v ? "border-ink bg-paper font-semibold text-ink" : "border-transparent text-sheet/60 hover:text-sheet"}`}
            >
              {v === "client" ? "📱 María's phone (client)" : "🗂 Luis's desk (preparer)"}
            </button>
          ))}
          <span className="mb-1.5 ml-auto hidden font-mono text-[10px] uppercase tracking-widest text-sheet/40 sm:inline">real engine · real PayPal sandbox · simulated IRS documents &amp; clock</span>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-h-0 overflow-y-auto overflow-x-hidden">
          {view === "desk" ? <PreparerPanel cases={[kase]} onOpenClient={() => setView("client")} /> : <ClientApp key={kase.client} token={kase.client} />}
        </div>
        <aside className="hidden min-h-0 flex-col border-l-[1.5px] border-ink bg-ink text-sheet lg:flex" data-tour-ticker>
          <div className="border-b border-sheet/10 px-4 py-2.5">
            <div className="font-mono text-[11px] font-bold uppercase tracking-widest text-sky-300">PayPal calls · live sandbox</div>
            <div className="mt-0.5 text-xs text-sheet/50">api-m.sandbox.paypal.com · every money move with its object id and PayPal-Debug-Id</div>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
            {!ticks.length && <div className="px-1 text-sm text-sheet/50">Nothing yet — no money moves while the return is wrong.</div>}
            {ticks.map((t, i) => (
              <div key={t.id} className={`rounded-md border px-3 py-2 text-xs ${t.guardian ? "border-rose-400/40" : "border-sky-400/25"} ${i === 0 ? "tour-new" : ""}`}>
                <TickLine t={t} full />
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function TickLine({ t, full }: { t: Tick; full?: boolean }) {
  if (t.guardian)
    return (
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-rose-300">Capture refused by the money guardian</span>
          <span className="ml-auto tabular-nums text-sheet/40">{t.at}</span>
        </div>
        {full && <div className="mt-0.5 text-rose-200/80">No PayPal call made · {t.conditions.join(" · ")}</div>}
      </div>
    );
  const c = t.call!;
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="font-semibold text-sky-200">{c.label}</span>
        {c.httpStatus && <span className="text-sheet/50">HTTP {c.httpStatus}</span>}
        <span className="ml-auto tabular-nums text-sheet/40">{t.at}</span>
      </div>
      {full && c.endpoint && <div className="mt-0.5 break-all font-mono text-[11px] text-sheet/60">{c.endpoint}</div>}
      <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px]">
        {c.objectId && (
          <span className="text-sheet/80">
            {c.objectKind} <span className="select-all text-sheet">{c.objectId}</span>
          </span>
        )}
        {c.debugId && (
          <span className="text-sky-300">
            Debug-ID <span className="select-all">{c.debugId}</span>
          </span>
        )}
        {full && c.link && (
          <a href={c.link} target="_blank" rel="noreferrer" className="text-sky-200 underline" title="Opens the transaction in the PayPal sandbox (merchant login)">
            sandbox ↗
          </a>
        )}
      </div>
    </div>
  );
}

function Finale({ latest, fee }: { ticks: Tick[]; latest: (k: PayPalCall["objectKind"]) => PayPalCall | null; fee?: number }) {
  const rows: [string, string, PayPalCall | null][] = [
    ["Order", "created with intent AUTHORIZE", latest("order")],
    ["Held", `${usd(fee)} authorized when María approved`, latest("authorization")],
    ["Collected", "captured only after the verified IRS acknowledgment", latest("capture")],
    ["Refunded", "fee returned when the IRS record proved the refund was diverted", latest("refund")],
  ];
  return (
    <div data-tour-finale>
      <div className="font-mono text-[11px] uppercase tracking-widest text-mark">The whole story · done</div>
      <div className="mt-1 font-display text-2xl leading-tight sm:text-3xl">The AI explained every step. The code decided every dollar. PayPal moved it.</div>
      <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
        {rows.map(([k, d, c]) => (
          <li key={k} className="leading-snug">
            <span className="mr-2 font-mono text-[11px] font-bold uppercase text-mark">{k}</span>
            <span className="text-sheet/80">{d}</span>
            {c?.objectId && (
              <div className="font-mono text-[11px] text-sky-300">
                {c.objectKind} <span className="select-all text-sheet">{c.objectId}</span> · Debug-ID <span className="select-all">{c.debugId ?? "—"}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-x-4 text-sm">
        <Link href="/arena" className="underline decoration-mark underline-offset-2">
          Agent Arena →
        </Link>
        <Link href="/lab" className="underline decoration-mark underline-offset-2">
          Fraud Lab →
        </Link>
        <Link href="/connect" className="underline decoration-mark underline-offset-2">
          API &amp; MCP →
        </Link>
      </div>
    </div>
  );
}
