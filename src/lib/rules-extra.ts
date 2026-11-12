// Extra deterministic pre-filing rules (Fraud Lab). Same contract as preFilingRules: pure, typed
// values in, findings out; the AI never decides. Derived from published IRS limits (TY2025,
// approximate) — not fitted to the lab labels.
// Wire-up (rules.ts, end of preFilingRules):  f.push(...extraPreFilingRules(intake, v, { preparerPtin }));
import type { Finding, Intake, Values } from "./rules";
import type { L10n } from "./i18n";
import { fmtUSD } from "./i18n";
import { eitcAmount, CTC_PER_CHILD, ACTC_CAP_PER_CHILD } from "./lab/tax2025";

export type ExtraCtx = { preparerPtin: string; taxYear?: number };

const m = (es: string, en: string, pt: string): L10n => ({ es, en, pt });
const SE_HI: Record<Intake["selfEmployed"], number> = { none: 0, "<10k": 1_000_000, "10-20k": 2_000_000, "20-40k": 4_000_000, ">40k": Infinity };

/** Proposed fix for R10 (sumsOk in reader.ts ignores line 29 AOTC and line 31 Form 4136 credits, so a
 *  legitimate education credit is flagged as an arithmetic error). */
export function sumsOkAllCredits(v: Values): boolean {
  if (v.refund === undefined || v.withholding === undefined || v.total_tax === undefined) return true;
  const expected = (v.withholding ?? 0) + (v.eitc ?? 0) + (v.actc ?? 0) + (v.aotc ?? 0) + (v.fuel_credit_4136 ?? 0) - (v.total_tax ?? 0);
  return Math.abs(expected - v.refund) <= 1400;
}

/** Proposed fix before R14: IRS account transcripts print credits (806 withholding, 768 EITC) as negative
 *  amounts and the reader returns them as printed; R14 compares magnitudes with the approved return. */
export function normalizeTranscript(v: Values): Values {
  const out: Values = { ...v };
  for (const k of ["tx_150", "tx_806", "tx_768", "tx_846", "tx_826", "tx_898", "tx_290", "tx_766"] as const) if (out[k] !== undefined) out[k] = Math.abs(out[k]!);
  return out;
}

export function extraPreFilingRules(intake: Intake, v: Values, ctx: ExtraCtx): Finding[] {
  const f: Finding[] = [];
  const ty = ctx.taxYear ?? 2025;
  const age = (y: number) => ty - y;
  // Children the client told us about who could be EITC-qualifying (lived > 6 months, under 24).
  const eitcKids = Math.min(3, intake.dependents.filter((d) => d.months > 6 && age(d.birthYear) < 24).length);
  const ctcKids = intake.dependents.filter((d) => d.months > 6 && age(d.birthYear) < 17).length;
  const sc = Math.max(0, (v.schedule_c_net ?? 0) / 100);
  const wages = (v.wages ?? 0) / 100;
  const earned = wages + sc - Math.round((sc * 0.9235 * 0.153) / 2);
  const agi = v.agi !== undefined ? v.agi / 100 : earned;

  // X1: EITC above the maximum the table allows for the children the client told us about and the
  // income on the return. Uses the most generous thresholds (MFJ) because filing status is not asked.
  const eitc = (v.eitc ?? 0) / 100;
  if (eitc > 0 && intake.idType === "SSN") {
    const allowed = eitcAmount(earned, agi, eitcKids, "mfj");
    if (eitc > allowed + 100)
      f.push({
        rule: "X1",
        severity: "IMPORTANT",
        rowKey: "eitc",
        message: m(
          `El crédito por ingreso del trabajo (${fmtUSD(eitc * 100)}) supera el máximo de la tabla del IRS para ${eitcKids} hijo(s) y estos ingresos (≈${fmtUSD(allowed * 100)}).`,
          `The earned income credit (${fmtUSD(eitc * 100)}) exceeds the IRS table maximum for ${eitcKids} child(ren) at this income (≈${fmtUSD(allowed * 100)}).`,
          `O crédito por renda do trabalho (${fmtUSD(eitc * 100)}) excede o máximo da tabela do IRS para ${eitcKids} filho(s) com essa renda (≈${fmtUSD(allowed * 100)}).`,
        ),
      });
  }

  // X2: child tax credit / ACTC above the per-child limits for children under 17 the client named.
  const ctcAll = ((v.ctc ?? 0) + (v.actc ?? 0)) / 100;
  if (ctcKids > 0 && (ctcAll > CTC_PER_CHILD * ctcKids + 50 || (v.actc ?? 0) / 100 > ACTC_CAP_PER_CHILD * ctcKids + 50))
    f.push({
      rule: "X2",
      severity: "IMPORTANT",
      rowKey: "ctc",
      message: m(
        `Se reclama crédito por hijos por más niños menores de 17 de los que nos indicó (${ctcKids}).`,
        `The child tax credit is claimed for more children under 17 than you told us about (${ctcKids}).`,
        `O crédito por filhos é reivindicado para mais crianças menores de 17 do que você informou (${ctcKids}).`,
      ),
    });

  // X3: self-employment income outside what the client said AND it creates/raises EITC.
  // (R4a/R4b only ask to clarify; when it feeds a refundable credit it is the classic EITC-maximizing scheme.)
  const net = v.schedule_c_net ?? null;
  if (net !== null && net !== 0 && intake.selfEmployed !== "none" && eitc > 0) {
    const hi = SE_HI[intake.selfEmployed];
    // Inflated income into the EITC plateau is the scheme; a first-year LOSS usually lowers EITC → just ask.
    if (net < 0 || net > hi * 1.3)
      f.push({
        rule: "X3",
        severity: net < 0 ? "CLARIFY" : "IMPORTANT",
        rowKey: "self_employment",
        message: m(
          "El resultado del negocio (Schedule C) no corresponde a lo que nos dijo y aumenta su crédito EITC. Así se infla un reembolso.",
          "The business result (Schedule C) doesn't match what you told us and it increases your EITC. That is how refunds get inflated.",
          "O resultado do negócio (Schedule C) não corresponde ao que você informou e aumenta seu EITC. É assim que reembolsos são inflados.",
        ),
      });
  }
  return f;
}
