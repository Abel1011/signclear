// TY2025 federal amounts — APPROXIMATE and ILLUSTRATIVE (whole dollars, simplified formulas).
// Used to build a coherent synthetic corpus and by plausibility rules in rules-extra.ts.
// Not tax advice; not the IRS tables (which use $50 income bands).

export type Filing = "single" | "hoh" | "mfj" | "mfs";

export const STD_DEDUCTION: Record<Filing, number> = { single: 15_750, hoh: 23_625, mfj: 31_500, mfs: 15_750 };

const BRACKETS: Record<Filing, [number, number][]> = {
  single: [[11_925, 0.1], [48_475, 0.12], [103_350, 0.22], [Infinity, 0.24]],
  hoh: [[17_000, 0.1], [64_850, 0.12], [103_350, 0.22], [Infinity, 0.24]],
  mfj: [[23_850, 0.1], [96_950, 0.12], [206_700, 0.22], [Infinity, 0.24]],
  mfs: [[11_925, 0.1], [48_475, 0.12], [103_350, 0.22], [Infinity, 0.24]],
};

export function incomeTax(taxable: number, filing: Filing): number {
  let tax = 0;
  let prev = 0;
  for (const [top, rate] of BRACKETS[filing]) {
    if (taxable <= prev) break;
    tax += (Math.min(taxable, top) - prev) * rate;
    prev = top;
  }
  return Math.round(tax);
}

/** EITC parameters by number of qualifying children (0..3+). */
export const EITC = {
  rate: [0.0765, 0.34, 0.4, 0.45],
  earnedAmount: [8_490, 12_730, 17_880, 17_880],
  max: [649, 4_328, 7_152, 8_046],
  phaseoutStart: [10_620, 23_350, 23_350, 23_350],
  phaseoutStartMfj: [17_730, 30_470, 30_470, 30_470],
  phaseoutRate: [0.0765, 0.1598, 0.2106, 0.2106],
};

export function eitcAmount(earned: number, agi: number, kids: number, filing: Filing): number {
  const k = Math.max(0, Math.min(3, kids));
  if (earned <= 0) return 0;
  let credit = Math.min(EITC.rate[k] * earned, EITC.max[k]);
  const start = filing === "mfj" ? EITC.phaseoutStartMfj[k] : EITC.phaseoutStart[k];
  const greater = Math.max(agi, earned);
  if (greater > start) credit -= EITC.phaseoutRate[k] * (greater - start);
  return Math.max(0, Math.round(credit));
}

export const CTC_PER_CHILD = 2_200;
export const ACTC_CAP_PER_CHILD = 1_700;

export type ReturnInput = {
  filing: Filing;
  idType: "SSN" | "ITIN";
  wages: number;
  withholding: number;
  seNet: number; // Schedule C net (may be negative)
  eitcKids: number; // qualifying children used for EITC
  ctcKids: number; // children under 17 used for CTC/ACTC
  aotc?: number; // refundable portion shown on line 29
  fuel?: number; // Form 4136 credit
};

export type ReturnCalc = {
  seTax: number;
  agi: number;
  taxable: number;
  incomeTax: number;
  ctc: number; // nonrefundable part (line 19)
  actc: number; // line 28
  eitc: number; // line 27
  totalTax: number; // line 24
  aotc: number;
  fuel: number;
  totalPayments: number;
  refund: number; // may be <= 0 (balance due)
};

/** Whole-dollar, coherent 1040 numbers. */
export function computeReturn(r: ReturnInput): ReturnCalc {
  const se = Math.max(0, r.seNet);
  const seTax = se > 400 ? Math.round(se * 0.9235 * 0.153) : 0;
  const halfSe = Math.round(seTax / 2);
  const agi = r.wages + r.seNet - halfSe;
  const earned = Math.max(0, r.wages + se - halfSe);
  const taxable = Math.max(0, agi - STD_DEDUCTION[r.filing]);
  const itax = incomeTax(taxable, r.filing);
  const ssn = r.idType === "SSN";
  const ctcTotal = ssn ? CTC_PER_CHILD * r.ctcKids : 0;
  const ctc = Math.min(ctcTotal, itax);
  const actc = ssn ? Math.max(0, Math.min(ctcTotal - ctc, ACTC_CAP_PER_CHILD * r.ctcKids, Math.round(0.15 * Math.max(0, earned - 2_500)))) : 0;
  // Married filing separately: treated as EITC-ineligible here (simplification; the separated-spouse exception is not modeled).
  const eitc = ssn && r.filing !== "mfs" ? eitcAmount(earned, agi, r.eitcKids, r.filing) : 0;
  const totalTax = itax - ctc + seTax;
  const aotc = r.aotc ?? 0;
  const fuel = r.fuel ?? 0;
  const totalPayments = r.withholding + eitc + actc + aotc + fuel;
  return { seTax, agi, taxable, incomeTax: itax, ctc, actc, eitc, totalTax, aotc, fuel, totalPayments, refund: totalPayments - totalTax };
}
