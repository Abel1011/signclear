"use client";
import { useEffect, useRef, useState } from "react";
import { tr, type CaseView, type Lang } from "./useCase";
import { APP_NAME } from "@/lib/brand";
import { VOICE_COPY, plainCondition } from "@/lib/i18n";

/** A guardian's refusal in plain words; the rule id stays visible as a small tag (for judges/auditors). */
export function Refusal({ conditions, lang, prep, client }: { conditions: string[]; lang: Lang; prep: string; client: string }) {
  const items = conditions.map((c) => plainCondition(c, { prep, client }));
  const seen = new Set<string>();
  return (
    <ul className="space-y-1">
      {items
        .filter((i) => (seen.has(i.text.en) ? false : (seen.add(i.text.en), true)))
        .map((i, k) => (
          <li key={k}>
            {tr(i.text, lang)}
            {i.tag && <span className="ml-2 rounded-sm border border-ink/30 px-1 py-px align-middle font-mono text-[10px] text-ink-soft">{i.tag}</span>}
          </li>
        ))}
    </ul>
  );
}

/** Wordmark: "Sign" in ink italic + "Clear" on a highlighter swipe, with a pen-stroke underline. */
export function Logo({ sub }: { sub?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="leading-none">
        <div className="relative font-display text-[28px] leading-none text-ink">
          <em>Sign</em>
          <span className="hl" style={{ paddingLeft: 1 }}>Clear</span>
          <svg className="absolute -bottom-1.5 left-0 h-2 w-[70%]" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden>
            <path d="M1 5 C 20 1, 35 8, 55 4 S 85 2, 99 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </svg>
        </div>
        {sub && <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-soft">{sub}</div>}
      </div>
    </div>
  );
}

const STAMP: Record<string, { l: string; c: string }> = {
  CREATED: { l: "Order", c: "text-ink-soft" },
  AUTHORIZED: { l: "Held", c: "text-ask" },
  COMPLETED: { l: "Paid", c: "text-ok" },
  PENDING: { l: "Pending", c: "text-ink-soft" },
  VOIDED: { l: "Void", c: "text-ink" },
  REFUNDED: { l: "Refunded", c: "text-diff" },
  NOT_APPROVED: { l: "Not approved", c: "text-diff" },
};
/** PayPal money state as a rubber stamp. */
export function Stamp({ status, small, label }: { status: string; small?: boolean; label?: string }) {
  const s = STAMP[status];
  if (!s) return <span className="text-ink-soft">—</span>;
  return <span key={status} className={`stamp stamp-anim ${s.c} ${small ? "text-[11px]" : "text-base"}`}>{label ?? s.l}</span>;
}

export function Bell({ items, lang, onOpen }: { items: CaseView["notifications"]; lang: Lang; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const unread = items.filter((n) => !n.read).length;
  return (
    <div className="relative">
      <button
        aria-label="notifications"
        onClick={() => {
          setOpen(!open);
          if (!open) onOpen();
        }}
        className="relative grid h-10 w-10 place-items-center rounded-md border-[1.5px] border-ink bg-sheet text-ink transition hover:bg-white"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M10 20a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-sm border border-ink bg-mark px-1 font-mono text-[11px] font-bold text-ink">{unread}</span>}
      </button>
      {open && (
        <div className="card absolute right-0 z-30 mt-2 w-[min(360px,calc(100vw-2rem))] p-2">
          <div className="eyebrow px-3 py-2">{tr({ es: "Avisos", en: "Notifications", pt: "Avisos" }, lang)}</div>
          {items.length === 0 && <div className="px-3 pb-3 text-sm text-ink-soft">—</div>}
          {items.map((n) => (
            <div key={n.id} className="rounded-xl px-3 py-2.5 text-sm hover:bg-paper">
              <div className="text-ink">{tr(n.text, lang)}</div>
              <div className="mt-0.5 text-xs text-ink-soft">{new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function LangPicker({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  const L: [Lang, string][] = [
    ["es", "Español"],
    ["en", "English"],
    ["pt", "Português"],
  ];
  return (
    <div className="flex items-center rounded-md border-[1.5px] border-ink bg-sheet p-0.5">
      {L.map(([k, n]) => (
        <button key={k} onClick={() => onChange(k)} className={`rounded-sm px-2.5 py-1 text-sm transition sm:px-3 ${lang === k ? "bg-ink text-sheet" : "text-ink-soft hover:text-ink"}`}>
          <span className="sm:hidden">{k.toUpperCase()}</span>
          <span className="hidden sm:inline">{n}</span>
        </button>
      ))}
    </div>
  );
}

const TONE = {
  ok: { box: "border-ok bg-ok-soft", icon: "bg-ok text-sheet", glyph: "✓" },
  info: { box: "border-ink/60 bg-sheet", icon: "bg-ink text-sheet", glyph: "i" },
  warn: { box: "border-ink bg-mark/60", icon: "bg-ink text-mark", glyph: "!" },
};

export function Banner({ tone, title, children }: { tone: keyof typeof TONE; title?: React.ReactNode; children?: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <div className={`flex gap-3 rounded-md border-[1.5px] px-5 py-4 ${t.box}`}>
      <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-sm font-mono text-sm font-bold ${t.icon}`}>{t.glyph}</span>
      <div className="min-w-0 text-[15px] leading-relaxed text-ink">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={title ? "text-ink-soft" : ""}>{children}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ voice
const VOICE_LANG: Record<Lang, string> = { es: "es-US", en: "en-US", pt: "pt-BR" };

function pickVoice(lang: Lang): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const want = VOICE_LANG[lang].toLowerCase();
  const base = want.slice(0, 2);
  return (
    voices.find((v) => v.lang.toLowerCase().replace("_", "-") === want) ??
    // es-MX / es-ES, pt-PT, en-GB… are better than reading Spanish with an English voice.
    voices.find((v) => v.lang.toLowerCase().startsWith(base)) ??
    null
  );
}

/** "Listen": reads text aloud with the browser's own voices (no audio leaves the device). Hidden if unsupported. */
export function ListenButton({ text, lang, small, dark }: { text: string; lang: Lang; small?: boolean; dark?: boolean }) {
  const [speaking, setSpeaking] = useState(false);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    setOk(typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined");
    return () => {
      // Stop reading if the message disappears (screen change).
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);
  if (!ok || !text.trim()) return null;
  const toggle = () => {
    const s = window.speechSynthesis;
    if (speaking) {
      s.cancel();
      setSpeaking(false);
      return;
    }
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = VOICE_LANG[lang];
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.rate = 0.92; // a little slower: easier to follow
    u.onend = u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    s.speak(u);
  };
  const label = tr(speaking ? VOICE_COPY.stop : VOICE_COPY.listen, lang);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={speaking}
      aria-label={label}
      data-listen
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border-[1.5px] font-sans font-semibold transition ${small ? "px-2 py-0.5 text-[11px]" : "px-3 py-1.5 text-sm"} ${
        dark ? "border-sheet/60 text-sheet hover:bg-sheet/10" : "border-ink/40 bg-sheet text-ink hover:border-ink"
      } ${speaking ? "bg-mark text-ink" : ""}`}
    >
      <svg width={small ? 12 : 14} height={small ? 12 : 14} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 9v6h4l5 4V5L8 9H4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        {speaking ? <path d="M17 9l4 6M21 9l-4 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
      </svg>
      {label}
    </button>
  );
}

type Recognition = { lang: string; interimResults: boolean; maxAlternatives: number; start: () => void; stop: () => void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null };

/** Optional voice question (Web Speech API, Chrome/Edge). Puts the words in the box; the client still presses Send. */
export function MicButton({ lang, onText }: { lang: Lang; onText: (t: string) => void }) {
  const [Ctor, setCtor] = useState<(new () => Recognition) | null>(null);
  const [on, setOn] = useState(false);
  const rec = useRef<Recognition | null>(null);
  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (C && window.isSecureContext) setCtor(() => C);
    return () => rec.current?.stop();
  }, []);
  if (!Ctor) return null;
  const toggle = () => {
    if (on) {
      rec.current?.stop();
      return;
    }
    try {
      const r = new Ctor();
      r.lang = VOICE_LANG[lang];
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.onresult = (e) => {
        const t = e.results[0]?.[0]?.transcript ?? "";
        if (t.trim()) onText(t.trim());
      };
      r.onerror = r.onend = () => setOn(false);
      rec.current = r;
      r.start();
      setOn(true);
    } catch {
      setOn(false);
    }
  };
  const label = tr(on ? VOICE_COPY.listening : VOICE_COPY.speak, lang);
  return (
    <button type="button" onClick={toggle} aria-label={label} title={label} aria-pressed={on} className={`grid h-[42px] w-[42px] shrink-0 place-items-center rounded-md border-[1.5px] border-ink/40 ${on ? "bg-mark text-ink [animation:pulse-ring_1.6s_infinite]" : "bg-sheet text-ink hover:border-ink"}`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "now" : "next";
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`grid h-7 w-7 place-items-center rounded-sm font-mono text-xs font-bold ${
                state === "done" ? "border-[1.5px] border-ink bg-ink text-mark" : state === "now" ? "border-[1.5px] border-ink bg-mark text-ink" : "border-[1.5px] border-ink/25 text-ink-soft"
              }`}
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className={`text-sm ${state === "now" ? "font-semibold text-ink" : "text-ink-soft"}`}>{s}</span>
            {i < steps.length - 1 && <span className="mx-1 w-8 border-t-[1.5px] border-dashed border-ink/30" />}
          </li>
        );
      })}
    </ol>
  );
}
