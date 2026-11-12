// Deterministic comparison rules. The agent cannot change their output.
import type { L10n } from "./i18n";
import { fmtUSD } from "./i18n";
import { extraPreFilingRules } from "./rules-extra";

export type Intake = {
  name: string;
  last4: string;
  idType: "SSN" | "ITIN";
  dependents: { relation: string; birthYear: number; months: number; country: string }[];
  w2Wages?: number | null; // cents, from client's own W-2 (read by AI)
  w2Withholding?: number | null;
  selfEmployed: "none" | "<10k" | "10-20k" | "20-40k" | ">40k";
  expenses: ("education" | "ev" | "solar")[];
  refundAcctLast4: string;
  refundAcctType: "checking" | "savings";
  payMethod: "separate" | "from_refund";
};

/** Typed values from the quarantined reader. Money in cents. */
export type Values = Partial<{
  taxpayer_name: string;
  ssn_last4: string;
  preparer_name: string;
  ptin: string;
  preparer_signed: boolean;
  self_prepared: boolean;
  is_draft: boolean;
  dependents_count: number;
  wages: number;
  schedule_c_net: number | null;
  agi: number;
  total_tax: number;
  withholding: number;
  eitc: number;
  ctc: number;
  actc: number;
  aotc: number;
  fuel_credit_4136: number;
  refund: number;
  refund_acct_last4: string;
  refund_acct_type: string;
  f8888_multiple: boolean;
  f8879_present: boolean;
  f8879_agi: number;
  f8879_total_tax: number;
  f8879_withholding: number;
  f8879_refund: number;
  sums_ok: boolean;
  // transcript + deposit (after filing)
  tx_150: number;
  tx_806: number;
  tx_768: number;
  tx_846: number;
  tx_290: number;
  tx_766: number;
  tx_826: number;
  tx_898: number;
  deposit_received: number;
}>;

export type Severity = "IMPORTANT" | "CLARIFY" | "POSITIVE" | "CONFIRM";
export type Finding = { rule: string; severity: Severity; rowKey: string; message: L10n };

const SE_RANGE: Record<Intake["selfEmployed"], [number, number]> = {
  none: [0, 0],
  "<10k": [1, 1_000_000],
  "10-20k": [1_000_000, 2_000_000],
  "20-40k": [2_000_000, 4_000_000],
  ">40k": [4_000_000, Infinity],
};

const m = (es: string, en: string, pt: string): L10n => ({ es, en, pt });

export function preFilingRules(intake: Intake, v: Values, preparerPtin: string): Finding[] {
  const f: Finding[] = [];
  // R10: arithmetic / critical fields
  if (v.sums_ok === false)
    f.push({ rule: "R10", severity: "CONFIRM", rowKey: "refund", message: m("Las sumas del 1040 no cuadran; confirme el valor.", "Form 1040 totals don't add up; please confirm.", "As somas do 1040 não batem; confirme o valor.") });
  // R1 / R2
  if (!v.preparer_signed || v.self_prepared)
    f.push({ rule: "R1", severity: "IMPORTANT", rowKey: "preparer", message: m("La sección del preparador pagado está vacía o dice 'self-prepared'.", "The paid preparer section is empty or says 'self-prepared'.", "A seção do preparador pago está vazia ou diz 'self-prepared'.") });
  if (!v.ptin || !/^P\d{8}$/.test(v.ptin) || v.ptin !== preparerPtin)
    f.push({ rule: "R2", severity: "IMPORTANT", rowKey: "preparer", message: m("Falta el PTIN del preparador o no coincide.", "The preparer's PTIN is missing or doesn't match.", "O PTIN do preparador está ausente ou não confere.") });
  // R8
  if ((v.ssn_last4 && v.ssn_last4 !== intake.last4) || (v.taxpayer_name && !sameName(v.taxpayer_name, intake.name)))
    f.push({ rule: "R8", severity: "IMPORTANT", rowKey: "identity", message: m("El nombre o los últimos 4 dígitos no coinciden con los suyos.", "Name or last 4 digits don't match yours.", "Nome ou últimos 4 dígitos não conferem.") });
  // R5 dependents
  const told = intake.dependents.length;
  if (v.dependents_count !== undefined) {
    if (v.dependents_count > told)
      f.push({ rule: "R5", severity: "IMPORTANT", rowKey: "dependents", message: m(`Su declaración dice ${v.dependents_count} dependientes; usted nos contó ${told}.`, `Your return lists ${v.dependents_count} dependents; you told us ${told}.`, `Sua declaração diz ${v.dependents_count} dependentes; você nos disse ${told}.`) });
    else if (v.dependents_count < told)
      f.push({ rule: "R5", severity: "CLARIFY", rowKey: "dependents", message: m(`Su declaración dice ${v.dependents_count} dependientes; usted nos contó ${told}.`, `Your return lists ${v.dependents_count} dependents; you told us ${told}.`, `Sua declaração diz ${v.dependents_count} dependentes; você nos disse ${told}.`) });
  }
  // R6 / R6b credits
  const kids17 = intake.dependents.filter((d) => new Date().getFullYear() - 1 - d.birthYear < 17 && d.months > 6).length;
  if ((v.ctc ?? 0) + (v.actc ?? 0) > 0 && kids17 === 0)
    f.push({ rule: "R6", severity: "IMPORTANT", rowKey: "ctc", message: m("Se reclama el crédito por hijos, pero no nos indicó hijos menores de 17.", "The child tax credit is claimed, but you listed no children under 17.", "O crédito por filhos é reivindicado, mas você não indicou filhos menores de 17.") });
  if ((v.aotc ?? 0) > 0 && !intake.expenses.includes("education"))
    f.push({ rule: "R6", severity: "IMPORTANT", rowKey: "credits_other", message: m("Se reclama un crédito por estudios que usted no mencionó.", "An education credit is claimed that you didn't mention.", "Um crédito educacional é reivindicado que você não mencionou.") });
  if ((v.fuel_credit_4136 ?? 0) > 0)
    f.push({ rule: "R6", severity: "IMPORTANT", rowKey: "credits_other", message: m("Se reclama un crédito por combustible (4136) que usted no mencionó.", "A fuel tax credit (4136) is claimed that you didn't mention.", "Um crédito de combustível (4136) é reivindicado que você não mencionou.") });
  if (intake.idType === "ITIN" && ((v.eitc ?? 0) > 0 || (v.ctc ?? 0) + (v.actc ?? 0) > 0))
    f.push({ rule: "R6b", severity: "IMPORTANT", rowKey: "eitc", message: m("Con ITIN, estos créditos requieren SSN válido (el crédito de $500 por otros dependientes sí se permite). Pregunte a su preparador.", "With an ITIN, these credits require a valid SSN (the $500 credit for other dependents is still allowed). Ask your preparer.", "Com ITIN, esses créditos exigem SSN válido (o crédito de $500 por outros dependentes é permitido). Pergunte ao seu preparador.") });
  // R4 self-employment (light)
  const net = v.schedule_c_net ?? null;
  if (net !== null && net !== 0 && intake.selfEmployed === "none")
    f.push({ rule: "R4", severity: "IMPORTANT", rowKey: "self_employment", message: m("Su declaración incluye un negocio propio (Schedule C) que usted no mencionó.", "Your return includes a business (Schedule C) you didn't mention.", "Sua declaração inclui um negócio (Schedule C) que você não mencionou.") });
  if (net !== null && intake.selfEmployed !== "none") {
    const [lo, hi] = SE_RANGE[intake.selfEmployed];
    if (net < 0)
      f.push({ rule: "R4b", severity: "CLARIFY", rowKey: "self_employment", message: m("Su negocio aparece con pérdida; usted indicó ganancias.", "Your business shows a loss; you indicated earnings.", "Seu negócio aparece com prejuízo; você indicou ganhos.") });
    else if (net < lo * 0.7 || net > hi * 1.3)
      f.push({ rule: "R4a", severity: "CLARIFY", rowKey: "self_employment", message: m("Los ingresos de su negocio no están en el rango que nos indicó.", "Business income is outside the range you told us.", "A renda do negócio está fora da faixa informada.") });
  }
  // R7 wages / withholding vs own W-2
  if (intake.w2Wages != null && v.wages !== undefined && Math.abs(v.wages - intake.w2Wages) > 100)
    f.push({ rule: "R7", severity: "IMPORTANT", rowKey: "wages", message: m("Los salarios no coinciden con su W-2.", "Wages don't match your W-2.", "Os salários não conferem com seu W-2.") });
  if (intake.w2Withholding != null && v.withholding !== undefined && Math.abs(v.withholding - intake.w2Withholding) > 100)
    f.push({ rule: "R7", severity: "IMPORTANT", rowKey: "withholding", message: m("Las retenciones no coinciden con sus papeles.", "Withholding doesn't match your forms.", "As retenções não conferem com seus documentos.") });
  // R3 refund account
  if (v.f8888_multiple && v.refund_acct_last4 === intake.refundAcctLast4)
    f.push({ rule: "R3", severity: "CLARIFY", rowKey: "refund_account", message: m("Su reembolso se reparte en varias cuentas (Formulario 8888). Es legal; confirme que todas son suyas.", "Your refund is split across several accounts (Form 8888). That's allowed; confirm they're all yours.", "Seu reembolso é dividido em várias contas (Formulário 8888). É permitido; confirme que todas são suas.") });
  else if ((v.refund_acct_last4 && v.refund_acct_last4 !== intake.refundAcctLast4) || (v.refund_acct_type && v.refund_acct_type !== intake.refundAcctType))
    f.push({ rule: "R3", severity: "IMPORTANT", rowKey: "refund_account", message: m(`Su reembolso iría a la cuenta ****${v.refund_acct_last4}; usted nos dio ****${intake.refundAcctLast4}.`, `Your refund would go to account ****${v.refund_acct_last4}; you gave us ****${intake.refundAcctLast4}.`, `Seu reembolso iria para a conta ****${v.refund_acct_last4}; você nos deu ****${intake.refundAcctLast4}.`) });
  if ((v.refund ?? 0) > 0 && !v.refund_acct_last4 && !(v.f8888_multiple === false && v.refund_acct_type === "paper"))
    f.push({ rule: "R3", severity: "IMPORTANT", rowKey: "refund_account", message: m("No pudimos confirmar a qué cuenta iría su reembolso (¿reparto en varias cuentas?). Pida a su preparador que se lo muestre.", "We couldn't confirm which account your refund would go to (split across accounts?). Ask your preparer to show you.", "Não conseguimos confirmar para qual conta iria seu reembolso (dividido em várias contas?). Peça ao seu preparador para mostrar.") });
  // R12 / R11 8879
  if (!v.f8879_present)
    f.push({ rule: "R12", severity: "IMPORTANT", rowKey: "f8879", message: m("Falta la hoja de autorización (8879) o está en blanco.", "The authorization form (8879) is missing or blank.", "O formulário de autorização (8879) está ausente ou em branco.") });
  else {
    const off =
      Math.abs((v.f8879_agi ?? 0) - (v.agi ?? 0)) > 5000 ||
      Math.abs((v.f8879_total_tax ?? 0) - (v.total_tax ?? 0)) > 1400 ||
      Math.abs((v.f8879_withholding ?? 0) - (v.withholding ?? 0)) > 1400 ||
      Math.abs((v.f8879_refund ?? 0) - (v.refund ?? 0)) > 1400;
    if (off)
      f.push({ rule: "R11", severity: "IMPORTANT", rowKey: "f8879", message: m("Los importes de la hoja 8879 no coinciden con la declaración.", "Form 8879 amounts don't match the return.", "Os valores do 8879 não conferem com a declaração.") });
  }
  // Fraud Lab rules (IRS-published limits): EITC/CTC caps, invented dependents, fabricated Schedule C, etc.
  f.push(...extraPreFilingRules(intake, v, { preparerPtin }));
  return f;
}

/** R14: transcript vs approved snapshot. Returns null when explained or matching. */
export function r14(snapshot: Values, v: Values): { verdict: "SUBSTITUTED" | "DIVERTED" | "LEGIT_OFFSET" | "IRS_ADJUSTED" | "MATCH"; detail: L10n } {
  const tol = 1400;
  const offsets = (v.tx_826 ?? 0) + (v.tx_898 ?? 0);
  // Expected deposit = refund issued (846) − amounts the IRS/Treasury applied to debts (826/898).
  const expected = v.tx_846 !== undefined ? v.tx_846 - offsets : undefined;
  if (expected !== undefined && v.deposit_received !== undefined && v.deposit_received + tol < expected)
    return {
      verdict: "DIVERTED",
      detail: m(
        `El IRS emitió ${fmtUSD(v.tx_846!)}${offsets ? ` y aplicó ${fmtUSD(offsets)} a deudas` : ", sin compensaciones"}; deberían haber llegado ${fmtUSD(expected)} y llegaron ${fmtUSD(v.deposit_received)}. Faltan ${fmtUSD(expected - v.deposit_received)} que fueron a otra cuenta.`,
        `The IRS issued ${fmtUSD(v.tx_846!)}${offsets ? ` and applied ${fmtUSD(offsets)} to debts` : " with no offsets"}; ${fmtUSD(expected)} should have arrived and ${fmtUSD(v.deposit_received)} did. ${fmtUSD(expected - v.deposit_received)} went to another account.`,
        `O IRS emitiu ${fmtUSD(v.tx_846!)}${offsets ? ` e aplicou ${fmtUSD(offsets)} a dívidas` : ", sem compensações"}; deveriam ter chegado ${fmtUSD(expected)} e chegaram ${fmtUSD(v.deposit_received)}. Faltam ${fmtUSD(expected - v.deposit_received)} que foram para outra conta.`,
      ),
    };
  // An IRS correction (29x adjustment / CP12 notice) is not preparer misconduct: explain, never refund.
  if ((v.tx_290 ?? 0) !== 0)
    return { verdict: "IRS_ADJUSTED", detail: m("El IRS corrigió su declaración (código 290) y recibirá un aviso CP12. No es un cambio de su preparador; le ayudamos a leer el aviso.", "The IRS corrected your return (code 290) and you'll get a CP12 notice. That's not a change by your preparer; we'll help you read the notice.", "O IRS corrigiu sua declaração (código 290) e você receberá um aviso CP12. Não é uma mudança do seu preparador; ajudamos a ler o aviso.") };
  const substituted =
    (v.tx_150 !== undefined && Math.abs(v.tx_150 - (snapshot.total_tax ?? 0)) > tol) ||
    (v.tx_806 !== undefined && Math.abs(v.tx_806 - (snapshot.withholding ?? 0)) > tol) ||
    (v.tx_768 !== undefined && Math.abs(v.tx_768 - (snapshot.eitc ?? 0)) > tol) ||
    (v.tx_846 !== undefined && Math.abs(v.tx_846 - (snapshot.refund ?? 0)) > tol);
  if (substituted)
    return { verdict: "SUBSTITUTED", detail: m("El registro del IRS muestra importes distintos de los que usted aprobó: se presentó otra declaración.", "The IRS record shows amounts different from what you approved: a different return was filed.", "O registro do IRS mostra valores diferentes dos aprovados: outra declaração foi apresentada.") };
  if (offsets > 0)
    return { verdict: "LEGIT_OFFSET", detail: m("El IRS aplicó parte de su reembolso a una deuda (códigos 826/898) y el resto llegó completo. Recibirá una carta.", "The IRS applied part of your refund to a debt (codes 826/898) and the rest arrived in full. You'll get a letter.", "O IRS aplicou parte do reembolso a uma dívida (códigos 826/898) e o restante chegou completo. Você receberá uma carta.") };
  return { verdict: "MATCH", detail: m("El registro del IRS coincide con lo que aprobó.", "The IRS record matches what you approved.", "O registro do IRS confere com o que você aprovou.") };
}

export function verdict(findings: Finding[]): "MATCH" | "CLARIFY" | "DIFFERENCES" | "NEEDS_CONFIRMATION" {
  if (findings.some((x) => x.severity === "CONFIRM")) return "NEEDS_CONFIRMATION";
  if (findings.some((x) => x.severity === "IMPORTANT")) return "DIFFERENCES";
  if (findings.some((x) => x.severity === "CLARIFY")) return "CLARIFY";
  return "MATCH";
}

/** Same person even if printed "LAST, FIRST", with a middle initial, accents or different order. */
export function sameName(a: string, b: string) {
  const toks = (s: string) => norm(s.replace(/,/g, " ")).split(" ").filter((t) => t.replace(/\./g, "").length > 1);
  const A = new Set(toks(a)), B = new Set(toks(b));
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  const shared = [...small].filter((t) => big.has(t)).length;
  return shared === small.size && (small.size >= 2 || big.size < 2);
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
