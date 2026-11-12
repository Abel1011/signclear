// Fictitious demo data (TY2025 sample). Values are the "known truth" of the sample PDFs
// in /public/samples, used to replay cached extraction and to measure reader accuracy (N/N).
import type { Intake, Values } from "./rules";

export const PREPARER = {
  name: "Luis Pérez",
  business: "Pérez Tax Prep",
  ptin: "P01234567",
  efin: "123456",
};

export const MARIA_INTAKE: Intake = {
  name: "María González",
  last4: "4821",
  idType: "SSN",
  dependents: [
    { relation: "hija", birthYear: 2015, months: 12, country: "US" },
    { relation: "hijo", birthYear: 2018, months: 12, country: "US" },
    // Demo "aha" moment: her nephew stayed 5 months, so the preparer correctly left him off (R5 CLARIFY).
    { relation: "sobrino", birthYear: 2010, months: 5, country: "US" },
  ],
  w2Wages: 1_840_000,
  w2Withholding: 92_000,
  selfEmployed: "10-20k",
  expenses: [],
  refundAcctLast4: "1234",
  refundAcctType: "checking",
  payMethod: "separate",
};

export const MARIA_VALUES: Values = {
  taxpayer_name: "María González",
  ssn_last4: "4821",
  preparer_name: "Luis Pérez",
  ptin: "P01234567",
  preparer_signed: true,
  self_prepared: false,
  is_draft: false,
  dependents_count: 2,
  wages: 1_840_000,
  schedule_c_net: 1_420_000,
  agi: 3_159_700,
  total_tax: 200_600,
  withholding: 92_000,
  eitc: 541_500,
  ctc: 79_700,
  actc: 340_000, // refund = withholding 920 + EITC 5,415 + ACTC 3,400 − total tax 2,006 (SE tax) = 7,729
  aotc: 0,
  fuel_credit_4136: 0,
  refund: 772_900,
  refund_acct_last4: "1234",
  refund_acct_type: "checking",
  f8888_multiple: false,
  f8879_present: true,
  f8879_agi: 3_159_700,
  f8879_total_tax: 200_600,
  f8879_withholding: 92_000,
  f8879_refund: 772_900,
  sums_ok: true,
};

/** María's answers for the judge seats: the two children who lived with her all year (no nephew), so an
 *  honest return is a clean MATCH and the only thing the rules can flag is what the preparer changed. */
export const MARIA_SEAT_INTAKE: Intake = { ...MARIA_INTAKE, dependents: MARIA_INTAKE.dependents.slice(0, 2) };

/** Prevention scenario (public/samples/maria-1040-TY2025-FRAUD.pdf): same return, but line 35d routes the
 *  $7,729 refund to an account that is not María's. R3 must stop the approval before she signs. */
export const FRAUD_ACCT_LAST4 = "9931";
export const MARIA_FRAUD_VALUES: Values = { ...MARIA_VALUES, refund_acct_last4: FRAUD_ACCT_LAST4 };

export const SAMPLE_PDF = {
  maria: "/samples/maria-1040-TY2025-SAMPLE.pdf",
  carlos: "/samples/carlos-1040-TY2025-SAMPLE.pdf",
  fraud: "/samples/maria-1040-TY2025-FRAUD.pdf",
} as const;

/** IRS account transcript (SIMULATED) + deposit received, for the post-filing investigation. */
export const MARIA_TRANSCRIPT: Values = {
  tx_150: 200_600,
  tx_806: 92_000,
  tx_768: 541_500,
  tx_846: 772_900,
  tx_826: 0,
  tx_898: 0,
};
export const MARIA_DEPOSIT = 472_900;
/** Short-refund story: the FILED return carried a Form 8888 (not in the approved version) sending the missing
 *  $3,000 to this account. Same account as the fraud sample, so both stories point at one place. */
export const DIVERSION_ACCT_LAST4 = FRAUD_ACCT_LAST4;

/** How a replayed (cached) document read is labelled in the agent log. */
export const CACHED_READ_TEXT = (fields: number) => `Read live by Claude the first time this sample was uploaded; identical file → same ${fields} fields replayed instantly`;

export const SUBMISSION_ID = `${PREPARER.efin}${new Date().getFullYear()}045a1b2c3d`.padEnd(20, "0").slice(0, 20);

export const FIELD_COUNT = Object.keys(MARIA_VALUES).length;
