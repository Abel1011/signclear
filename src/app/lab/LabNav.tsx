import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/Bits";

export function LabNav({ active }: { active: "lab" | "radar" }) {
  const item = (href: string, label: string, on: boolean) => (
    <Link href={href} className={`chip ${on ? "chip-on" : ""}`}>
      {label}
    </Link>
  );
  return (
    <header className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-4 pt-6 sm:px-6">
      <Link href="/" aria-label="SignClear home">
        <Logo sub="Fraud Lab · measured protection" />
      </Link>
      <nav className="flex flex-wrap items-center gap-2">
        {item("/lab", "Fraud Lab", active === "lab")}
        {item("/radar", "Ghost-Preparer Radar", active === "radar")}
        {item("/", "Live demo", false)}
        <span className="badge-sim" title="Every person, preparer, PTIN and account in this corpus is fictitious">Synthetic corpus</span>
      </nav>
    </header>
  );
}

/** Switch between the recorded measurement and the re-score with today's rules (same reads, no new model calls). */
export function ModeSwitch({ mode, base, measuredAt }: { mode: "measured" | "current"; base: "/lab" | "/radar"; measuredAt: string }) {
  return (
    <div className="mx-auto mt-6 max-w-[1280px] px-4 sm:px-6">
      <div className={`card flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between ${mode === "current" ? "border-ask" : ""}`}>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Which rules score the stored reads">
          <Link role="tab" aria-selected={mode === "current"} href={base} className={`chip ${mode === "current" ? "chip-on" : ""}`}>
            Production rules today · re-scored on the same reads
          </Link>
          <Link role="tab" aria-selected={mode === "measured"} href={`${base}?rules=measured`} className={`chip ${mode === "measured" ? "chip-on" : ""}`}>
            As first measured · unseen, rules frozen at run time
          </Link>
        </div>
        <p className="max-w-[70ch] text-[12.5px] leading-snug text-ink-soft">
          {mode === "measured" ? (
            <>
              <b className="text-ink">The unseen measurement.</b> Rules as of commit <code className="font-mono">{measuredAt}</code>, frozen before any model read the unseen set.
            </>
          ) : (
            <>
              <b className="text-ask">Not an unseen measurement.</b> The rules were changed after seeing these results; the same cached reads are re-scored with today&apos;s production rules — zero new model calls.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export function Big({ value, label, sub, tone = "ink" }: { value: string; label: string; sub?: ReactNode; tone?: "ink" | "ok" | "diff" | "ask" }) {
  const color = tone === "ok" ? "text-ok" : tone === "diff" ? "text-diff" : tone === "ask" ? "text-ask" : "text-ink";
  return (
    <div className="card flex min-w-0 flex-col justify-between gap-2 p-4">
      <div className="eyebrow">{label}</div>
      <div className={`font-display text-[44px] leading-none sm:text-[52px] ${color}`}>{value}</div>
      {sub && <div className="text-[13px] leading-snug text-ink-soft">{sub}</div>}
    </div>
  );
}
