// Pure evaluation of one lab case: typed values (from the real reader, or ground truth in oracle
// mode) -> the rules exactly as production runs them -> what the money guardians would have allowed.
//
// production: mirrors engine.ts review() / compareTranscript():
//   v.sums_ok = sumsOkAllCredits(v); preFilingRules(intake, v, ptin)   (preFilingRules already ends with X1–X3)
//   r14(snapshot, normalizeTranscript(v))
// core: ablation of the SAME findings without the X-rules (rules-extra.ts) -> "core rules R1–R12 only".
// Nothing is ever applied twice.
import { preFilingRules, verdict as verdictOf, r14, type Finding, type Intake, type Values } from "../rules";
import { normalizeTranscript, sumsOkAllCredits } from "../rules-extra";
import { fmtUSD } from "../i18n";
import { isFraud, isPost, type LabCase, type VariantOutcome } from "./types";

const BLOCKING = new Set(["DIFFERENCES", "NEEDS_CONFIRMATION"]);
const PROPOSES_REFUND = new Set(["SUBSTITUTED", "DIVERTED"]);
/** Rules that live in rules-extra.ts (written while building the v1 dev corpus). */
export const isExtraRule = (rule: string) => /^X\d+$/.test(rule);

export function outcomeFor(c: Pick<LabCase, "scheme" | "fee">, verdict: string, rules: string[]): VariantOutcome {
  const fraud = isFraud(c.scheme);
  const fee = fmtUSD(c.fee);
  if (verdict === "READ_FAILED")
    return { rules, verdict, detected: true, warnedOnly: false, moneyMovedWrongly: false, paypal: "Reader failed: the case stays in its previous state (fail-closed). No PayPal call." };
  if (isPost(c.scheme)) {
    const proposed = PROPOSES_REFUND.has(verdict);
    return {
      rules,
      verdict,
      detected: proposed,
      warnedOnly: false,
      moneyMovedWrongly: fraud ? !proposed : proposed,
      paypal: proposed
        ? `R14 opens REFUND_PROPOSED: preparer gets 72 h to refute; then the guardian refunds the ${fee} fee via PayPal.`
        : `Case closed (${verdict}): the captured ${fee} fee stands.`,
    };
  }
  const blocked = BLOCKING.has(verdict);
  return {
    rules,
    verdict,
    detected: blocked,
    warnedOnly: fraud && verdict === "CLARIFY",
    moneyMovedWrongly: fraud && verdict === "MATCH",
    paypal: blocked
      ? `No PayPal order: createOrder requires MATCH (verdict ${verdict}). The ${fee} fee is never authorized.`
      : verdict === "CLARIFY"
        ? `Client sees a CLARIFY warning; only if they explicitly accept it can PayPal authorize ${fee} (captured after IRS acceptance).`
        : `Client can approve: PayPal authorizes ${fee}; captured after the IRS accepts the return.`,
  };
}

/** The pre-filing findings production computes for these read values (same steps as engine.ts review()). */
export function productionPreFiling(intake: Intake, read: Values, preparerPtin: string): { values: Values; findings: Finding[] } {
  const v: Values = { ...read };
  v.sums_ok = sumsOkAllCredits(v);
  return { values: v, findings: preFilingRules(intake, v, preparerPtin) };
}

/** The post-filing verdict production computes (same steps as engine.ts compareTranscript()). */
export function productionPostFiling(snapshot: Values, read: Values, deposit: number) {
  const v: Values = { ...read, deposit_received: deposit };
  return { values: v, res: r14(snapshot, normalizeTranscript(v)) };
}

/** Marks whether a detection on read values is backed by the same evidence as on the true values. */
export function withReason(read: VariantOutcome, truth: VariantOutcome): VariantOutcome {
  if (!read.detected || read.verdict === "READ_FAILED") return { ...read, rightReason: false };
  if (read.rules.some((r) => r.startsWith("R14:"))) return { ...read, rightReason: read.verdict === truth.verdict };
  const blocking = (o: VariantOutcome) => new Set(o.rules.filter((r) => /:(IMPORTANT|CONFIRM)$/.test(r)).map((r) => r.split(":")[0]));
  const t = blocking(truth);
  return { ...read, rightReason: [...blocking(read)].some((r) => t.has(r)) };
}

const tag = (xs: Finding[]) => xs.map((x) => `${x.rule}:${x.severity}`);

export function evaluateCase(c: LabCase, read: Values, preparerPtin: string): { production: VariantOutcome; core: VariantOutcome; values: Values } {
  if (isPost(c.scheme)) {
    const { values, res } = productionPostFiling(c.post!.snapshot, read, c.post!.deposit);
    const o = outcomeFor(c, res.verdict, [`R14:${res.verdict}`]);
    return { production: o, core: o, values }; // R14 has no extra-rule counterpart
  }
  const { values, findings } = productionPreFiling(c.intake, read, preparerPtin);
  const core = findings.filter((f) => !isExtraRule(f.rule));
  return { production: outcomeFor(c, verdictOf(findings), tag(findings)), core: outcomeFor(c, verdictOf(core), tag(core)), values };
}
