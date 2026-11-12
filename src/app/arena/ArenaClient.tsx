"use client";
import { useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Bits";
import { SCENARIOS, SIDES, TASK, verdictLine, type ArenaRunView, type Outcome, type ScenarioId, type Side, type Step } from "@/lib/arena/scenarios";

const IDS = Object.keys(SCENARIOS) as ScenarioId[];
type Live = { trace: Step[]; outcome?: Outcome; running: boolean };

const TONE: Record<string, string> = {
  good: "border-ok bg-ok-soft text-ok",
  bad: "border-diff bg-diff-soft text-diff",
  warn: "border-ask bg-ask-soft text-ask",
  info: "border-ink/30 bg-white text-ink",
};

function fmtInput(x: unknown) {
  const s = JSON.stringify(x ?? {});
  return s === "{}" ? "()" : `(${s.length > 160 ? s.slice(0, 160) + "…" : s})`;
}

function StepRow({ s }: { s: Step }) {
  const [open, setOpen] = useState(false);
  switch (s.kind) {
    case "agent":
      return (
        <li className="rounded-md border border-ink/15 bg-white px-3 py-2 text-[13px] leading-relaxed">
          <span className="eyebrow mr-2">PrepBot</span>
          <span className="whitespace-pre-line">{s.text}</span>
        </li>
      );
    case "call":
      return (
        <li className="flex min-w-0 items-start gap-2 font-mono text-[12px]">
          <span className={`mt-px shrink-0 rounded-sm px-1.5 text-[10px] font-bold uppercase ${s.via === "mcp" ? "bg-ink text-paper" : "border border-ink/30 text-ink-soft"}`}>{s.via === "mcp" ? "MCP" : "tool"}</span>
          <span className="min-w-0 break-all">
            <b>{s.tool}</b>
            <span className="text-ink-soft">{fmtInput(s.input)}</span>
          </span>
        </li>
      );
    case "result": {
      const lines = s.text.split("\n");
      const long = lines.length > 3 || s.text.length > 260;
      return (
        <li className={`ml-6 rounded-md border px-2.5 py-1.5 font-mono text-[11.5px] ${s.refused?.length ? TONE.good : s.ok ? "border-ink/10 bg-sheet text-ink-soft" : "border-diff/40 bg-white text-diff"}`}>
          {s.refused?.length ? (
            <div>
              <div className="font-sans text-xs font-bold uppercase tracking-wide">Guardian refused</div>
              <ul className="mt-1 list-disc pl-4">
                {s.refused.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <pre className="whitespace-pre-wrap break-words">{open || !long ? s.text : lines.slice(0, 3).join("\n").slice(0, 260) + " …"}</pre>
              {long && (
                <button onClick={() => setOpen(!open)} className="mt-1 font-sans text-[11px] font-semibold underline underline-offset-2">
                  {open ? "less" : "more"}
                </button>
              )}
            </>
          )}
        </li>
      );
    }
    case "world":
      return (
        <li className={`rounded-md border-l-4 px-3 py-2 text-[13px] ${TONE[s.tone ?? "info"]}`}>
          <div className="text-[11px] font-bold uppercase tracking-wide">{s.actor}</div>
          <div className="whitespace-pre-line text-ink">{s.text}</div>
        </li>
      );
    case "injection":
      return (
        <li className="rounded-md border-[1.5px] border-dashed border-diff bg-white px-3 py-2 text-[12px]">
          <div className="text-[11px] font-bold uppercase tracking-wide text-diff">Hidden injection · {s.where}</div>
          <code className="break-words text-ink-soft">{s.text}</code>
        </li>
      );
    case "error":
      return <li className="text-[12px] font-semibold text-diff">{s.text}</li>;
  }
}

function Column({ side, run, live }: { side: Side; run?: ArenaRunView; live?: Live }) {
  const trace = live?.trace ?? run?.trace ?? [];
  const outcome = live ? live.outcome : run?.outcome;
  const naive = side === "naive";
  return (
    <section className={`min-w-0 rounded-md border-[1.5px] bg-sheet ${naive ? "border-diff" : "border-ink"}`}>
      <div className={`border-b-[1.5px] px-4 py-3 ${naive ? "border-diff bg-diff-soft/60" : "border-ink bg-mark/50"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-3xl">{SIDES[side].title}</h2>
          {naive && <span className="rounded-sm border border-diff px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-diff">Simulated · no money moves</span>}
          {!naive && <span className="rounded-sm bg-ink px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-paper">MCP · real guardians</span>}
        </div>
        <p className="mt-1 text-xs text-ink-soft">{SIDES[side].sub}</p>
      </div>
      {outcome ? (
        <div className={`m-3 rounded-md border-[1.5px] px-3 py-2.5 ${TONE[outcome.tone]}`}>
          <div className="text-[11px] font-bold uppercase tracking-wide">Outcome</div>
          <div className="font-display text-2xl leading-tight text-ink">{outcome.headline}</div>
          {outcome.facts.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[13px] text-ink">
              {outcome.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="m-3 rounded-md border border-dashed border-ink/30 px-3 py-2.5 text-sm text-ink-soft">{live?.running ? "Running…" : "No recorded run yet."}</div>
      )}
      {live?.running ? (
        <ol className="space-y-2 px-3 pb-4">
          {trace.map((s, i) => (
            <StepRow key={i} s={s} />
          ))}
          <li className="animate-pulse font-mono text-xs text-ink-soft">agent thinking…</li>
        </ol>
      ) : (
        <>
          {/* Key moments first: what happened in the world, hidden injections, refusals. The full agent trace is one click away. */}
          <div className="px-3 pb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">Key moments</div>
          <ol className="space-y-2 px-3 pb-3">
            {trace
              .filter((s) => s.kind === "world" || s.kind === "injection" || s.kind === "error" || (s.kind === "result" && (!s.ok || (s.refused?.length ?? 0) > 0)))
              .map((s, i) => (
                <StepRow key={i} s={s} />
              ))}
          </ol>
          <details className="mx-3 mb-4 rounded-md border border-dashed border-ink/30 px-3 py-2">
            <summary className="cursor-pointer font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-soft">Full agent trace · {trace.length} steps</summary>
            <ol className="mt-2 space-y-2">
              {trace.map((s, i) => (
                <StepRow key={i} s={s} />
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}

export function ArenaClient({ initial }: { initial: Record<string, ArenaRunView> }) {
  const [runs, setRuns] = useState(initial);
  const [sc, setSc] = useState<ScenarioId>(initial["malicious:naive"] ? "malicious" : "honest");
  const [live, setLive] = useState<Partial<Record<Side, Live>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const busy = !!live && Object.values(live).some((l) => l?.running);

  const left = runs[`${sc}:naive`];
  const right = runs[`${sc}:signclear`];
  const verdict = live ? verdictLine(live.naive?.outcome, live.signclear?.outcome) : verdictLine(left?.outcome, right?.outcome);

  async function runLive() {
    setErr(null);
    const fresh: Partial<Record<Side, Live>> = { naive: { trace: [], running: true }, signclear: { trace: [], running: true } };
    setLive({ ...fresh });
    const r = await fetch("/arena/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: sc }) });
    if (!r.ok || !r.body) {
      const j = await r.json().catch(() => ({}));
      setErr(j.error ?? "Live run failed.");
      setLive(null);
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const m = JSON.parse(line) as { type: string; side: Side; step?: Step; run?: ArenaRunView; message?: string };
        if (m.type === "step" && m.step) fresh[m.side] = { ...fresh[m.side]!, trace: [...fresh[m.side]!.trace, m.step] };
        if (m.type === "done" && m.run) {
          fresh[m.side] = { trace: m.run.trace, outcome: m.run.outcome, running: false };
          setRuns((x) => ({ ...x, [`${sc}:${m.side}`]: m.run! }));
        }
        if (m.type === "error") setErr(m.message ?? "Live run failed.");
      }
      setLive({ ...fresh });
    }
    setLive(null);
  }

  return (
    <div className="min-h-full">
      <header className="border-b-[1.5px] border-ink bg-paper">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
          <Logo sub="Agent Arena" />
          <nav className="ml-auto flex gap-4 text-sm">
            <Link href="/" className="underline underline-offset-2">Preparer desk</Link>
            <Link href="/connect" className="underline underline-offset-2">Connect your agent</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] space-y-5 px-4 py-6 sm:px-8 sm:py-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="eyebrow">Same agent · same task · two worlds</div>
            <h1 className="font-display text-4xl sm:text-5xl">
              Agent <em>Arena</em>
            </h1>
            <p className="mt-2 text-ink-soft">
              Task given to the AI preparer agent (Claude): <b className="text-ink">“{TASK}”</b> Left, it files and bills directly. Right, it uses SignClear&apos;s MCP tools — the
              client reviews before signing, and the fee moves only through the money guardians.
            </p>
          </div>
          <button onClick={runLive} disabled={busy} className="btn-primary shrink-0">
            {busy ? "Running live…" : "Run live"}
          </button>
        </section>

        <div className="flex flex-wrap gap-2" role="tablist">
          {IDS.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={sc === id}
              disabled={busy}
              onClick={() => setSc(id)}
              className={`rounded-md border-[1.5px] border-ink px-3 py-1.5 text-sm font-semibold ${sc === id ? "bg-ink text-paper" : "bg-sheet hover:bg-white"}`}
            >
              {SCENARIOS[id].short}
            </button>
          ))}
        </div>
        <p className="text-sm text-ink-soft">
          <b className="text-ink">{SCENARIOS[sc].title}.</b> {SCENARIOS[sc].blurb}
        </p>
        {err && <p className="rounded-md border border-diff bg-diff-soft px-3 py-2 text-sm text-diff">{err}</p>}

        {verdict && (
          <div className="rounded-md border-[1.5px] border-ink bg-ink px-4 py-3 text-paper shadow-[4px_4px_0_0_var(--color-mark)]">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-70">Verdict</div>
            <div className="font-display text-2xl leading-snug sm:text-3xl">{verdict}</div>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <Column side="naive" run={left} live={live?.naive} />
          <Column side="signclear" run={right} live={live?.signclear} />
        </div>
        <p className="text-xs text-ink-soft">
          {left || right ? `Recorded ${new Date((right ?? left)!.createdAt).toLocaleString()} · model ${(right ?? left)!.model} · ` : ""}
          The IRS, the tax software and the client María are simulated; fictitious data. SignClear&apos;s engine, client-review rules and money guardians are the production code. Live runs are
          rate-limited.
        </p>
      </main>
    </div>
  );
}
