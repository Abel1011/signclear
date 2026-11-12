"use client";
import { useCallback, useEffect, useState } from "react";
import { ClientApp } from "@/components/ClientApp";
import { PreparerPanel, type DeskCase } from "@/components/PreparerPanel";
import { AgentLog } from "@/components/AgentLog";
import { useCase, usd, type CaseView } from "@/components/useCase";
import { Logo } from "@/components/Bits";
import Link from "next/link";
import { Tour } from "@/components/Tour";
import { fetchJsonRetry } from "@/lib/fetch-retry";
import { APP_NAME, AGENT_NAME } from "@/lib/brand";

type View = "desk" | number;
type Seat = "fraud" | "clean" | "collect" | "short";
type Ctx = { cases: DeskCase[]; m?: CaseView | null; c?: CaseView | null };
type Step = {
  title: string;
  who: "Luis (preparer)" | "Client" | "Clock";
  carlos?: boolean;
  screen: (x: Ctx) => View;
  hint: string;
  sim?: { label: string; go: (x: Ctx) => Promise<unknown> };
  done: (x: Ctx) => boolean;
};

const post = (token: string, type: string, extra: Record<string, unknown> = {}) =>
  fetch(`/api/case/${token}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...extra }) }).then((r) => r.json());

const ORDER = ["CASE_CREATED", "CONSENTED", "PROCESSING", "CLARIFY", "DIFFERENCES", "MATCH", "AUTHORIZED", "TRANSMITTED", "CAPTURE_PENDING", "CAPTURED", "INVESTIGATING", "REFUND_PROPOSED", "REFUND_PENDING", "REFUNDED"];
const atLeast = (v: CaseView | null | undefined, s: string) => !!v && (ORDER.indexOf(v.state) >= ORDER.indexOf(s) || ["CLOSED", "UNRESOLVED"].includes(v.state));

const STEPS: Step[] = [
  {
    title: "Open a case for your client",
    who: "Luis (preparer)",
    screen: () => "desk",
    hint: "You are Luis, a tax preparer. Create a case for María González — she'll get a private link.",
    done: (x) => x.cases.length > 0,
  },
  {
    title: "María answers her interview",
    who: "Client",
    screen: () => 0,
    hint: "Switch to María's link. Answer in her language — or press “Fill with an example” (it includes a nephew who lived with her 5 months). Sign the consent and continue.",
    done: (x) => atLeast(x.m, "CONSENTED"),
  },
  {
    title: "Luis uploads her return",
    who: "Luis (preparer)",
    screen: () => "desk",
    hint: `Press “Use the sample return” (or upload your own PDF). ${AGENT_NAME} reads it (about 10 s) and compares every line with María's answers. (Upload the fraud sample — /samples/maria-1040-TY2025-FRAUD.pdf — to watch the approval get blocked.)`,
    done: (x) => atLeast(x.m, "CLARIFY"),
  },
  {
    title: `María reviews it with ${AGENT_NAME}`,
    who: "Client",
    screen: () => 0,
    hint: `Where something differs, ${AGENT_NAME} explains it in her language (press Listen to hear it). Press “Ask Luis”, send the question she drafts, answer from Luis's desk, then “I confirmed it with Luis”. If the refund went to someone else's account, nothing can be approved until Luis fixes it.`,
    done: (x) => atLeast(x.m, "MATCH"),
  },
  {
    title: "María approves → PayPal holds the fee",
    who: "Client",
    screen: () => 0,
    hint: "Press Approve and pay with PayPal. The fee is only authorized — nothing is charged yet.",
    done: (x) => atLeast(x.m, "AUTHORIZED"),
  },
  {
    title: "Luis files with the IRS",
    who: "Luis (preparer)",
    screen: () => "desk",
    hint: "Record the IRS e-file Submission ID (“generate one” builds a valid-format ID: EFIN + year + day). The fee is still only on hold.",
    done: (x) => atLeast(x.m, "TRANSMITTED"),
  },
  {
    title: "IRS confirms → PayPal collects",
    who: "Luis (preparer)",
    screen: () => "desk",
    hint: "First try “Ask to be paid now”: the AI agent attempts it and the code refuses. Then upload the IRS confirmation — only then PayPal captures the fee.",
    done: (x) => atLeast(x.m, "CAPTURED"),
  },
  {
    title: "Her refund arrives short",
    who: "Client",
    screen: () => 0,
    hint: `María approved a $7,729 refund. Report what actually reached her bank — try $4,729. ${AGENT_NAME} starts finding out why.`,
    done: (x) => atLeast(x.m, "INVESTIGATING"),
  },
  {
    title: `${AGENT_NAME} checks the IRS record`,
    who: "Client",
    screen: () => 0,
    hint: "Upload her IRS transcript. The IRS issued the full $7,729 (code 846, no offsets), but the filed return carried a Form 8888 sending $3,000 to ****9931 — a split María never approved. A fee refund is proposed.",
    done: (x) => atLeast(x.m, "REFUND_PROPOSED"),
  },
  {
    title: "Luis gets 72 hours to explain",
    who: "Clock",
    screen: () => "desk",
    hint: "Luis can answer with evidence from his desk. Or let the time run out.",
    sim: { label: "Fast-forward 72 hours", go: (x) => post(x.cases[0].preparer, "advance_clock", { hours: 73 }) },
    done: (x) => atLeast(x.m, "REFUNDED") || x.m?.state === "UNRESOLVED" || (x.m?.state === "REFUND_PROPOSED" && (x.m?.guards.refund ?? []).every((g) => g.includes("client"))),
  },
  {
    title: "María confirms → PayPal refunds",
    who: "Client",
    screen: () => 0,
    hint: "Press “I confirm…”. The code checks the IRS record, the 72 h and her confirmation, then PayPal refunds her fee.",
    done: (x) => x.m?.state === "REFUNDED" || x.m?.state === "UNRESOLVED",
  },
];

const at = (i: number, patch: Partial<Step> = {}): Step => ({ ...STEPS[i], ...patch });
const IDX = { approve: 4, file: 5, collect: 6, short: 7, transcript: 8, clock: 9, confirm: 10 };

/** Judge seats: a short guide that starts at the interesting moment of a sample case. */
const SEAT_STEPS: Record<Seat, (reached: boolean) => Step[]> = {
  fraud: () => [
    {
      title: `${AGENT_NAME} stops María before she signs`,
      who: "Client",
      screen: () => 0,
      hint: "Luis's return sends María's $7,729 refund to account ****9931 — not hers (****1234). Approval is blocked and PayPal holds nothing. Switch to Español to see what María sees (and press Listen), then ask Luis to fix it and send Clara's drafted question.",
      done: (x) => !!x.m?.chat.some((k) => k.text.startsWith("__QUESTIONS_SENT__")) || atLeast(x.m, "MATCH"),
    },
    {
      title: "Luis uploads the corrected return",
      who: "Luis (preparer)",
      screen: () => "desk",
      hint: `María's question is on Luis's desk. Press “Use the sample return” — the honest version, refund to ****1234. ${AGENT_NAME} reads it again (about 10 s).`,
      done: (x) => atLeast(x.m, "MATCH"),
    },
    at(IDX.approve, { title: "Now it's right → María approves, PayPal holds the fee", hint: "Every line matches. Press Approve and pay with the PayPal sandbox buyer: the fee is only authorized — nothing is charged until the IRS accepts." }),
  ],
  clean: () => [
    at(IDX.approve, { title: "María's return is clean → approve with PayPal", hint: "All lines match what María told us. Press Approve and pay with the PayPal sandbox buyer: the fee is only authorized — nothing is charged yet." }),
    at(IDX.file),
    at(IDX.collect),
  ],
  collect: (reached) =>
    reached
      ? [at(IDX.collect, { title: "Luis tries to get paid before the IRS accepts", hint: "Luis filed and the fee is on hold. Press “Ask to be paid now”: the AI agent tries to capture and the code refuses (no IRS acceptance). Then upload the IRS confirmation — only then PayPal collects." })]
      : [at(IDX.approve), at(IDX.file), at(IDX.collect, { title: "Luis tries to get paid before the IRS accepts" })],
  short: (reached) =>
    reached
      ? [
          at(IDX.transcript, { title: "The refund arrived $3,000 short", hint: `María approved $7,729; $4,729 reached her bank. ${AGENT_NAME} explains what she'll check. Press “Upload IRS transcript and deposit”: the IRS issued the full $7,729 (code 846, no offsets); the filed Form 8888 sent $3,000 to ****9931, which María never approved. A fee refund is proposed.` }),
          at(IDX.clock),
          at(IDX.confirm),
        ]
      : [at(IDX.approve), at(IDX.file), at(IDX.collect), at(IDX.short), at(IDX.transcript), at(IDX.clock), at(IDX.confirm)],
};

const SEAT_CARDS: { seat: Seat; title: string; wow: string; paypal?: boolean }[] = [
  { seat: "fraud", title: "María before signing — the fraud is caught", wow: "The preparer routed her $7,729 refund to someone else's account. Approval blocked; PayPal holds nothing." },
  { seat: "clean", title: "María's return is clean — approve with PayPal", wow: "Every line matches. Approve and watch PayPal hold the fee, not charge it.", paypal: true },
  { seat: "collect", title: "Luis tries to get paid before the IRS accepts", wow: "The AI agent asks to capture the fee. The code says no — until the IRS confirms." },
  { seat: "short", title: "The refund arrived short", wow: "$3,000 never reached María. The IRS record proves it was diverted; her fee comes back." },
];

type Desk = { cases: DeskCase[]; seat: Seat | null; reached?: boolean; note?: string | null };

export default function Home() {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [saved, setSaved] = useState<Desk | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tour, setTour] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("tour")) setTour(true);
  }, []);
  useEffect(() => {
    fetch("/api/desk/cases", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setSaved(j.cases?.length ? { cases: j.cases, seat: j.seat ?? null, reached: true } : null))
      .catch(() => undefined);
  }, []);
  async function open() {
    setBusy("desk");
    setErr(null);
    try {
      const r = await fetchJsonRetry<{ error?: string }>("/api/desk/open", { method: "POST" }, { timeoutMs: 20_000 });
      if (!r.ok) throw new Error(r.json.error ?? "Could not open the desk. Please try again.");
      setDesk({ cases: [], seat: null });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  }
  async function seat(s: Seat) {
    setBusy(s);
    setErr(null);
    try {
      // Retries network hiccups ("Failed to fetch") and gateway errors; each attempt opens a fresh private sample case.
      const r = await fetchJsonRetry<{ cases?: DeskCase[]; seat: Seat; reached?: boolean; note?: string; error?: string }>(
        "/api/desk/seats",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seat: s }) },
        { timeoutMs: 50_000 },
      );
      const j = r.json;
      if (!r.ok || !j.cases) throw new Error(j.error ?? "Could not open the sample case. Please try again.");
      setDesk({ cases: j.cases, seat: j.seat, reached: j.reached, note: j.note ?? null });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  }
  if (tour)
    return (
      <Tour
        onExit={() => setTour(false)}
        onTryIt={() => {
          setTour(false);
          open();
        }}
      />
    );
  if (!desk) return <Landing onTour={() => setTour(true)} onStart={open} onSeat={seat} onResume={saved ? () => setDesk(saved) : null} busy={busy} err={err} />;
  return (
    <Workspace
      key={desk.cases[0]?.client ?? "desk"}
      desk={desk}
      setCases={(cases) => setDesk({ ...desk, cases })}
      exit={() => (setSaved(desk.cases.length ? desk : null), setDesk(null))}
    />
  );
}

function Workspace({ desk, setCases, exit }: { desk: Desk; setCases: (c: DeskCase[]) => void; exit: () => void }) {
  const cases = desk.cases;
  const STEPS_NOW = desk.seat ? SEAT_STEPS[desk.seat](desk.reached !== false) : STEPS;
  const m = useCase(cases[0]?.client ?? null, { interval: 1500 });
  const c = useCase(cases[1]?.client ?? null, { interval: 1500 });
  const [view, setView] = useState<View>(desk.seat ? STEPS_NOW[0].screen({ cases }) : "desk");
  const [logOpen, setLogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sumOpen, setSumOpen] = useState(true);
  const x: Ctx = { cases, m: cases[0] ? m.data : null, c: cases[1] ? c.data : null };
  const loaded = !cases[0] || !!x.m;
  const idx = loaded ? STEPS_NOW.findIndex((s) => !s.done(x)) : 0;
  const finished = idx === -1;
  const s = finished ? null : STEPS_NOW[idx];
  const target = s ? s.screen(x) : "desk";
  const targetOk = typeof target === "number" ? target < cases.length : true;
  const onTarget = view === target;
  const viewName = (v: View) => (v === "desk" ? "Luis's desk" : `${cases[v]?.name.split(" ")[0] ?? "Client"}'s link`);
  const logToken = typeof view === "number" ? cases[view]?.client : cases[cases.length - 1]?.client;
  const addCase = useCallback((n: DeskCase) => setCases([...cases, n]), [cases, setCases]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      {/* Guide */}
      <div className="shrink-0 border-b-[1.5px] border-ink bg-ink text-sheet">
        <div className="flex h-1.5">
          {STEPS_NOW.map((st, i) => (
            <div key={i} title={st.title} className={`flex-1 ${i ? "ml-px" : ""} ${finished || i < idx ? "bg-mark" : i === idx ? "bg-sheet/70" : "bg-sheet/15"}`} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 sm:px-6">
          <div className="min-w-0 basis-full xl:basis-0 xl:flex-1">
            {s ? (
              <>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-sheet/50">
                  <span>
                    {desk.seat ? "Sample case" : "Guide"} · {idx + 1}/{STEPS_NOW.length}
                  </span>
                  <span className={`rounded-sm px-1.5 py-0.5 font-bold ${s.who === "Clock" ? "border border-sheet/40 text-sheet/80" : "bg-mark text-ink"}`}>{s.who === "Client" ? (s.carlos ? "Carlos (client)" : "María (client)") : s.who}</span>
                </div>
                <div className="mt-0.5 font-display text-xl leading-tight sm:text-2xl">{s.title}</div>
                <div className="mt-0.5 hidden max-w-4xl text-sm leading-snug text-sheet/70 sm:block">{s.hint}</div>
                {desk.note && idx === 0 && (
                  <div className="mt-1 max-w-4xl text-xs text-mark">
                    {/VAULT|not configured/i.test(desk.note)
                      ? "This sample starts one step earlier: approve María's return with PayPal yourself to continue."
                      : desk.note}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-widest text-mark">
                  {desk.seat ? "Sample case complete" : "Guide complete"}
                  <button onClick={() => setSumOpen(!sumOpen)} className="text-sheet/60 underline underline-offset-2 hover:text-sheet">
                    {sumOpen ? "hide" : "what you just saw"}
                  </button>
                </div>
                <div className="font-display text-xl sm:text-2xl">Every PayPal move was decided by code and explained by AI — here is what happened.</div>
                {sumOpen && <WhatYouSaw x={x} seat={desk.seat} />}
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {s && targetOk && !onTarget && (
              <button onClick={() => setView(target)} className="rounded-md border-[1.5px] border-mark bg-mark px-4 py-2 text-sm font-semibold text-ink [animation:pulse-ring_1.6s_infinite]">
                Go to {viewName(target)} →
              </button>
            )}
            {s?.sim && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await s.sim!.go(x);
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded-md border-[1.5px] border-dashed border-sheet/60 px-4 py-2 text-sm font-semibold text-sheet hover:bg-sheet/10 disabled:opacity-40"
              >
                ⏱ {busy ? "…" : s.sim.label}
              </button>
            )}
            {s && onTarget && !s.sim && <span className="font-mono text-xs text-mark">↓ act on the screen below</span>}
          </div>
        </div>
        {/* Screens */}
        <div className="flex items-end gap-1 px-4 sm:px-6">
          {(["desk", ...cases.map((_, i) => i)] as View[]).map((v) => (
            <button
              key={String(v)}
              onClick={() => setView(v)}
              className={`rounded-t-md border-x-[1.5px] border-t-[1.5px] px-3.5 py-1.5 text-sm ${view === v ? "border-ink bg-paper font-semibold text-ink" : "border-transparent text-sheet/60 hover:text-sheet"}`}
            >
              {v === "desk" ? (
                <>
                  🗂 Luis<span className="hidden sm:inline">&apos;s desk (preparer)</span>
                </>
              ) : (
                <>
                  📱 {cases[v]?.name.split(" ")[0]}
                  {cases.filter((k) => k.name === cases[v]?.name).length > 1 ? ` ${cases.filter((k, j) => k.name === cases[v]?.name && j <= (v as number)).length}` : ""}
                  <span className="hidden sm:inline">&apos;s link (client)</span>
                </>
              )}
            </button>
          ))}
          <button onClick={exit} className="mb-1.5 ml-auto font-mono text-[11px] uppercase tracking-widest text-sheet/50 hover:text-sheet">
            Start over
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {view === "desk" ? (
          <PreparerPanel cases={cases} onNewCase={(n) => addCase(n)} onOpenClient={(d) => setView(cases.findIndex((k) => k.client === d.client))} />
        ) : (
          cases[view] && <ClientApp key={cases[view].client} token={cases[view].client} />
        )}
      </div>
      <div className={`flex flex-col border-t-[1.5px] border-ink bg-ink transition-all ${logOpen ? "h-[30vh]" : "h-9"}`}>
        <button onClick={() => setLogOpen(!logOpen)} className="flex items-center gap-3 px-5 py-2 text-left font-mono text-[11px] uppercase tracking-widest text-sheet/70 hover:text-sheet">
          <span className="font-bold">{logOpen ? "▾" : "▸"} Under the hood</span>
          <span className="hidden normal-case tracking-normal text-sheet/40 sm:inline">agent tool calls · payment guardian · PayPal endpoint, object id and Debug-ID for every call</span>
        </button>
        {logOpen && (
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
            <div className="px-2 text-xs text-sheet/50">Real: PayPal sandbox, Claude (Clara&apos;s reader and agent), AG Grid. Simulated: IRS confirmation, IRS transcript, bank deposit, clock.</div>
            <div className="min-h-0 flex-1">{logToken ? <LogFor token={logToken} /> : <div className="px-2 text-sm text-sheet/50">No case yet.</div>}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** End-of-run recap: each money move with its PayPal ID, per case. */
function WhatYouSaw({ x, seat }: { x: Ctx; seat: Seat | null }) {
  const lines = (v: CaseView) => {
    const p = v.payment;
    const st = p?.status ?? "NONE";
    const out: [string, string, string | null | undefined][] = [];
    if (seat === "fraud") out.push(["Stopped", "Refund routed to ****9931 caught before signing — nothing held, nothing charged", null]);
    if (p?.authorizationId) out.push(["Held", `${usd(p.amount)} authorized when ${v.clientName.split(" ")[0]} approved`, p.authorizationId]);
    if (p?.captureId) out.push(["Collected", "captured only after the IRS confirmation", p.captureId]);
    if (st === "VOIDED") out.push(["Voided", "no IRS confirmation in time — the hold was released", p?.authorizationId]);
    if (p?.refundId) out.push(["Refunded", "IRS record proved the refund was diverted — fee returned", p.refundId]);
    if (!out.length) out.push(["—", `state ${v.state}`, null]);
    return out;
  };
  const list = [x.m, x.c].filter(Boolean) as CaseView[];
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2" data-what-you-saw>
      {list.map((v) => (
        <div key={v.id} className="rounded-md border border-sheet/25 px-3 py-2 text-sm">
          <div className="font-semibold">{v.clientName}</div>
          <ul className="mt-1 space-y-0.5">
            {lines(v).map(([k, d, id]) => (
              <li key={k} className="leading-snug">
                <span className="mr-2 font-mono text-[11px] font-bold uppercase text-mark">{k}</span>
                <span className="text-sheet/80">{d}</span>
                {id && <span className="ml-2 select-all font-mono text-[11px] text-sheet/60">PayPal {id}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function LogFor({ token }: { token: string }) {
  const { data } = useCase(token, { audit: true, interval: 1500 });
  return <AgentLog rows={data?.audit ?? []} payment={data?.payment} />;
}

/** The hero: a page of a tax return, annotated — what SignClear does, in one picture. */
function ReturnSheet() {
  const lines: [string, string, string, boolean?][] = [
    ["", "Dependents", "2"],
    ["1z", "Wages (W-2)", "18,400.00"],
    ["8", "Business income (Sch. C)", "14,200.00"],
    ["25d", "Federal tax withheld", "920.00"],
    ["27", "Earned income credit", "5,415.00"],
    ["35a", "Refund", "7,729.00"],
    ["35b", "Deposit to", "checking ****9931", true],
  ];
  return (
    <div className="relative mx-auto w-full max-w-[520px] pb-6 pr-4">
      {/* Clara's margin note */}
      <div className="relative z-10 mb-3 ml-auto mr-2 w-[min(18rem,85%)] -rotate-2 border-l-[3px] border-mark bg-sheet px-3 py-2 shadow-[3px_3px_0_0_rgba(22,21,19,0.85)]">
        <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">{AGENT_NAME} · in your language</div>
        <div className="font-display text-[17px] italic leading-snug">“Your $7,729 refund would go to account ****9931 — yours ends in 1234. Don&apos;t sign until Luis fixes it.”</div>
      </div>
      <div className="card relative rotate-[0.6deg] px-6 pb-6 pt-5">
        <div className="flex items-baseline justify-between border-b-[1.5px] border-ink pb-2">
          <div className="font-mono text-xs font-bold tracking-widest">FORM 1040 · 2025</div>
          <div className="font-mono text-[10px] text-ink-soft">María González · ***-**-4821</div>
        </div>
        <div className="mt-1">
          {lines.map(([ln, label, val, hl]) => (
            <div key={label} className="flex items-baseline gap-3 border-b border-dashed border-ink/20 py-2 text-sm">
              <span className="w-8 shrink-0 font-mono text-[11px] text-ink-soft">{ln}</span>
              <span className="flex-1">{hl ? <span className="hl hl-anim">{label}</span> : label}</span>
              <span className="font-mono font-semibold">{hl ? <span className="hl hl-anim">{val}</span> : val}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-end justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Client signature</div>
            <svg width="150" height="34" viewBox="0 0 150 34" aria-hidden className="text-ink">
              <path d="M4 24 C 14 6, 22 30, 30 16 S 44 4, 50 22 S 64 28, 72 14 S 90 10, 96 22 C 104 30, 118 8, 146 14" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            </svg>
          </div>
          <span className="stamp stamp-anim text-sm text-diff" style={{ animationDelay: "1.2s" }}>
            Not approved · PayPal holds $0
          </span>
        </div>
      </div>
    </div>
  );
}

const INSIDE: { href: string; title: string; line: string }[] = [
  { href: "/arena", title: "Agent Arena", line: "Adversarial AI preparers try to get paid early or divert refunds — watch the money guardian stop each one." },
  { href: "/lab", title: "Fraud Lab", line: "Honest accuracy of the return reader on an unseen set of PDFs, scans and photos." },
  { href: "/radar", title: "Radar", line: "Ghost-preparer detection across desks: a risky preparer's fees are held for review." },
  { href: "/connect", title: "API & MCP", line: "Plug SignClear into tax software: REST API with keys, OpenAPI spec and an MCP server." },
];

function Nav({ onTour }: { onTour: () => void }) {
  return (
    <nav className="flex flex-wrap items-center gap-x-5 gap-y-2" data-nav>
      <Logo />
      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <button onClick={onTour} className="font-semibold underline decoration-mark decoration-4 underline-offset-2">
          ▶ 90-second story
        </button>
        {INSIDE.map((k) => (
          <Link key={k.href} href={k.href} className="text-ink-soft hover:text-ink">
            {k.title}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function Landing({ onTour, onStart, onSeat, onResume, busy, err }: { onTour: () => void; onStart: () => void; onSeat: (s: Seat) => void; onResume: (() => void) | null; busy: string | null; err: string | null }) {
  const money = [
    ["Not approved", "text-diff", "The refund would go to someone else", `${AGENT_NAME} blocks the approval before she signs. PayPal holds nothing.`],
    ["Held", "text-ask", "She approves a return she understands", "PayPal authorizes the preparer's fee. Nothing is charged."],
    ["Paid", "text-ok", "The IRS confirms it received the return", "Only then is the fee captured."],
    ["Void", "text-ink", "The preparer never files", "The hold is cancelled automatically at the deadline."],
    ["Refunded", "text-diff", "The refund lands short", "The AI checks the IRS record; if the money was diverted, the fee comes back."],
  ] as const;
  return (
    <div className="min-h-screen overflow-x-hidden">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
        <Nav onTour={onTour} />
        <div className="mt-10 grid items-center gap-12 lg:mt-14 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <h1 className="font-display text-5xl leading-[0.98] sm:text-6xl lg:text-7xl">
              Never sign a tax return <em>you can&apos;t read.</em>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink">
              Millions of families sign tax returns in a language they don&apos;t read — and pay the preparer upfront. <span className="hl">{AGENT_NAME}</span> explains every line in their language and stops the return if the refund would go to someone else; <b>PayPal</b> pays the preparer only once the IRS confirms the return, and refunds the fee if the refund was diverted.
            </p>
            <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4">
              <button onClick={onTour} disabled={!!busy} className="btn-primary px-7 py-4 text-lg" data-cta-tour>
                ▶ Watch {APP_NAME} in 90 seconds
              </button>
              <button onClick={onStart} disabled={!!busy} className="btn-secondary">
                {busy === "desk" ? "Opening…" : "Try it yourself as the preparer"}
              </button>
            </div>
            <p className="mt-3 max-w-xl text-sm text-ink-soft">
              <b className="text-ink">90 seconds:</b> one click plays the whole story on a real case — fraud caught, PayPal authorizes, refuses to pay early, captures, then refunds — with every PayPal object id and Debug-ID as it happens. Pause or take over anytime.
            </p>
            <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
              <b className="text-ink">Yourself:</b> play both the preparer and the client — 11 short steps, about 8 minutes, a guide at the top shows each move.
              {onResume && (
                <button onClick={onResume} className="ml-2 font-semibold text-ink underline underline-offset-4">
                  Continue where I left off
                </button>
              )}
            </p>
          </div>
          <ReturnSheet />
        </div>

        <div className="mt-12" data-seats>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="eyebrow">Or jump straight into one moment</div>
            <div className="text-xs text-ink-soft">Sample cases · fictitious people · real engine, real PayPal sandbox, real AI</div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {SEAT_CARDS.map((k) => (
              <button
                key={k.seat}
                onClick={() => onSeat(k.seat)}
                disabled={!!busy}
                data-seat={k.seat}
                className={`card group flex flex-col items-start p-4 text-left transition hover:-translate-y-0.5 disabled:opacity-60 ${k.seat === "fraud" ? "border-diff" : ""}`}
              >
                <span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest ${k.seat === "fraud" ? "border-diff text-diff" : "border-ink/40 text-ink-soft"}`}>Sample case</span>
                <span className="mt-2 font-display text-xl leading-tight">{k.title}</span>
                <span className="mt-1.5 flex-1 text-sm text-ink-soft">{k.wow}</span>
                <span className="mt-3 text-sm font-semibold underline decoration-mark decoration-4 underline-offset-2">
                  {busy === k.seat ? "Preparing the case…" : "Open →"}
                </span>
                {k.paypal && <span className="mt-1 text-[11px] text-ink-soft">You&apos;ll pay with a PayPal sandbox test buyer.</span>}
              </button>
            ))}
          </div>
          {err && <div className="mt-3 text-sm font-semibold text-diff">{err}</div>}
        </div>

        <div className="mt-12" data-inside>
          <div className="eyebrow">What&apos;s inside</div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {INSIDE.map((k) => (
              <Link key={k.href} href={k.href} className="group border-l-[3px] border-ink py-1 pl-4 transition hover:border-mark">
                <div className="font-semibold">
                  {k.title} <span className="inline-block transition group-hover:translate-x-0.5">→</span>
                </div>
                <div className="mt-1 text-sm text-ink-soft">{k.line}</div>
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-16 border-t-[1.5px] border-ink pt-8">
          <div className="eyebrow">How the fee is protected</div>
          <div className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
            {money.map(([l, c, t, d]) => (
              <div key={l}>
                <span className={`stamp text-sm ${c}`}>{l}</span>
                <div className="mt-3 font-semibold">{t}</div>
                <div className="text-sm text-ink-soft">{d}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-16 grid gap-10 border-t-[1.5px] border-ink pt-8 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <div className="eyebrow">For tax preparers</div>
            <h2 className="mt-2 font-display text-4xl leading-tight sm:text-5xl">
              Get paid when the IRS accepts — <em>not weeks later.</em>
            </h2>
            <p className="mt-4 text-ink-soft">
              Honest preparers lose clients to the storefront that promises the biggest refund. {APP_NAME} turns trust into the reason to choose you.
            </p>
            <div className="mt-6 inline-flex items-baseline gap-3 rounded-md border-[1.5px] border-ink bg-sheet px-4 py-3">
              <span className="font-display text-4xl">$4</span>
              <span className="text-sm text-ink-soft">per approved return, paid by the preparer · free for clients</span>
            </div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            {[
              ["Paid in a day or two", "The fee is collected as soon as the IRS acknowledgment says Accepted — no waiting for a refund transfer to fund, no bank fee taken from your client's refund."],
              ["No walk-aways", "The fee is authorized the moment your client approves. Clients can't disappear after you file."],
              ["Fewer disputes", "Your client saw every line in their language and approved it. The approved return is snapshotted with the payment."],
              ["A badge that wins clients", "“Fee held with PayPal until IRS acceptance” tells families you only get paid for filing what they approved."],
            ].map(([t, d]) => (
              <div key={t} className="border-l-[3px] border-mark pl-4">
                <div className="font-semibold">{t}</div>
                <div className="mt-1 text-sm text-ink-soft">{d}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-10 rounded-md border-[1.5px] border-dashed border-ink/40 px-5 py-4 text-sm text-ink-soft">
          <b className="text-ink">Next:</b> IRS acknowledgments straight from e-file software (MeF) instead of an upload · IRS transcripts via IVES with the client&apos;s consent · PayPal multiparty so each preparer is the merchant of record · encrypted storage with automatic deletion.
        </div>
        <p className="mt-12 border-t border-dashed border-ink/30 pt-5 text-xs text-ink-soft">
          Built for the PayPal AI Hackathon. The IRS confirmation, IRS transcript, bank deposit and clock are simulated; people and documents are fictitious. Source: GAO-27-108176.
        </p>
      </div>
    </div>
  );
}
