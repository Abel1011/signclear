import type { Intake, Values } from "../rules";

export type Scheme =
  | "clean"
  | "refund_account"
  | "phantom_dependent"
  | "fake_schedule_c"
  | "inflated_credits"
  | "f8879_mismatch"
  | "ghost_preparer"
  | "bad_ptin"
  | "injection"
  | "post_clean"
  | "post_substituted"
  | "post_diverted";

export const SCHEME_LABEL: Record<Scheme, string> = {
  clean: "Clean return (control)",
  refund_account: "Refund routed to another account",
  phantom_dependent: "Invented dependent (EITC/CTC)",
  fake_schedule_c: "Fabricated Schedule C",
  inflated_credits: "Inflated / unmentioned credits",
  f8879_mismatch: "Form 8879 ≠ return",
  ghost_preparer: "Ghost preparer (blank / self-prepared)",
  bad_ptin: "Wrong or missing PTIN",
  injection: "Prompt injection + real fraud",
  post_clean: "Post-filing control (no fraud)",
  post_substituted: "Post-filing: substituted return",
  post_diverted: "Post-filing: diverted refund",
};

export const isPost = (s: Scheme) => s.startsWith("post_");
export const isFraud = (s: Scheme) => s !== "clean" && s !== "post_clean";

export type LabPreparer = {
  key: string; // PTIN registered with SignClear (the one the client expects)
  name: string;
  firm: string;
  kind: "human" | "ai_agent";
  bad: boolean; // ground truth for the radar (never shown to the rules)
  /** unseen set: what makes this preparer's book look the way it does (e.g. honest but noisy) */
  note?: string;
};

/** dev = corpus v1 (rules-extra was written while looking at it: NOT a test set).
 *  unseen = corpus v2, generated later with new parameters/layouts/document conditions and frozen
 *  (data/lab/unseen.lock.json) before any model or rule was run on it. */
export type Split = "dev" | "unseen";

/** Commit whose rules scored the recorded runs (data/lab/results-*.json). The rules changed after that commit
 *  using what the unseen set exposed; data/lab/rescored-*.json re-scores the SAME reads with today's rules. */
export const MEASURED_AT = "26f4ed0";
/** "measured" = recorded run, rules frozen at run time (the unseen measurement).
 *  "current"  = same cached reads re-scored with today's production rules (no longer an unseen test). */
export type ScoreMode = "measured" | "current";
/** What the reader receives: the generated text PDF, a scanner-style image-only PDF, or a phone photo. */
export type Condition = "pdf" | "scan" | "photo";
export const CONDITION_LABEL: Record<Condition, string> = { pdf: "Clean PDF (text layer)", scan: "Scanned image (grayscale, skewed, noisy)", photo: "Phone photo (rotated, shadowed, JPEG)" };

export type LabCase = {
  key: string;
  split: Split;
  /** unseen set: the same return rendered in several conditions shares a baseKey */
  baseKey?: string;
  condition?: Condition;
  /** what is actually sent to the reader (defaults to pdf) */
  doc?: string;
  mediaType?: "application/pdf" | "image/jpeg";
  scheme: Scheme;
  variant: string;
  description: string;
  expected: "BLOCK" | "PASS" | "SUBSTITUTED" | "DIVERTED" | "MATCH" | "LEGIT_OFFSET" | "IRS_ADJUSTED";
  preparerKey: string;
  clientLang: string;
  fee: number; // cents
  intake: Intake;
  /** What the PDF actually says (reader ground truth). For post cases: transcript values. */
  truth: Values;
  /** Post-filing: the return the client approved + the deposit the client reported. */
  post?: { snapshot: Values; deposit: number };
  injection?: { text: string; technique: string };
  pdf: string; // public path
};

export type LabCorpus = {
  version: number;
  generatedAt: string;
  note: string;
  seed: number;
  preparers: LabPreparer[];
  cases: LabCase[];
};

/** production = exactly what the app runs today (engine.ts: preFilingRules incl. rules-extra X1–X3,
 *  sums_ok = sumsOkAllCredits; post-filing r14 on normalizeTranscript). core = ablation: the same
 *  findings minus the X-rules, i.e. the core rules R1–R12 only. */
export type RuleVariant = "production" | "core";

export type LabCaseResult = {
  caseKey: string;
  baseKey?: string;
  scheme: Scheme;
  split: Split;
  condition: Condition;
  expected: string;
  preparerKey: string;
  error?: string;
  production: VariantOutcome;
  core: VariantOutcome;
  readerOk: number;
  readerTotal: number;
  readerMisses: { k: string; read: unknown; truth: unknown }[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  values?: Values;
};

export type VariantOutcome = {
  rules: string[]; // e.g. ["R3:IMPORTANT"]
  verdict: string;
  /** Rules stopped the money: pre-filing verdict blocks authorization, or post-filing R14 proposes a refund.
   *  On a fraud case this is a catch; on a clean case it is a false positive. */
  detected: boolean;
  warnedOnly: boolean; // fraud only reached CLARIFY (client must accept a visible warning)
  moneyMovedWrongly: boolean;
  paypal: string; // what PayPal would have done
  /** Stopped for the right reason: a blocking rule that also fires on the ground-truth values (or, after
   *  filing, the same R14 verdict). False when a misread happened to block the case. */
  rightReason?: boolean;
};
