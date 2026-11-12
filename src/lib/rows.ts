import type { Intake, Values, Finding } from "./rules";
import { fmtUSD, type L10n } from "./i18n";

export type RowStatus = "MATCH" | "CLARIFY" | "DIFFERENT" | "NOCHECK" | "CONFIRMED";
export type Row = {
  key: string;
  group: L10n;
  concept: L10n;
  cite: string;
  declaration: string;
  compareLabel: L10n;
  compare: string;
  f8879: string;
  papers: string;
  told: string;
  irs?: string;
  bank?: string;
  status: RowStatus;
  findings: Finding[];
};

const G = {
  family: { es: "Su familia", en: "Your family", pt: "Sua família" },
  earned: { es: "Lo que ganó", en: "What you earned", pt: "O que você ganhou" },
  credits: { es: "Ayudas del gobierno (créditos)", en: "Government help (credits)", pt: "Ajudas do governo (créditos)" },
  refund: { es: "Su reembolso", en: "Your refund", pt: "Seu reembolso" },
  prep: { es: "Quién la preparó", en: "Who prepared it", pt: "Quem preparou" },
};
const toldL = { es: "Usted nos dijo", en: "You told us", pt: "Você nos disse" };
const papersL = { es: "Sus papeles", en: "Your papers", pt: "Seus documentos" };
const f8879L = { es: "Hoja 8879", en: "Form 8879", pt: "Formulário 8879" };
const $ = (c?: number | null) => (c === undefined || c === null ? "—" : fmtUSD(c));

export type PostFiling = { snapshot: Values; split?: { acct: string; amount: number; mainAcct: string; mainAmount: number } | null };

export function buildRows(intake: Intake, v: Values, findings: Finding[], post?: PostFiling, lang: "es" | "en" | "pt" = "en"): Row[] {
  const L = (m: L10n) => m[lang] ?? m.en;
  const ACCT: Record<string, L10n> = { checking: { es: "corriente", en: "checking", pt: "corrente" }, savings: { es: "ahorros", en: "savings", pt: "poupança" } };
  const acct = (t?: string) => (t ? L(ACCT[t.toLowerCase()] ?? { es: t, en: t, pt: t }) : "—");
  const fs = (k: string) => findings.filter((f) => f.rowKey === k);
  const status = (k: string, checkable = true): RowStatus => {
    const f = fs(k);
    if (f.some((x) => x.severity === "IMPORTANT")) return "DIFFERENT";
    if (f.some((x) => x.severity === "CLARIFY" || x.severity === "CONFIRM")) return "CLARIFY";
    return checkable ? "MATCH" : "NOCHECK";
  };
  const base = (r: Omit<Row, "findings" | "status" | "f8879" | "papers" | "told"> & Partial<Row>, checkable = true): Row => ({
    f8879: "",
    papers: "",
    told: "",
    ...r,
    findings: fs(r.key),
    status: r.status ?? status(r.key, checkable),
  });
  const kids = intake.dependents.length;
  const SE: Record<string, string> = { none: "—", "<10k": "< $10,000", "10-20k": "$10,000–20,000", "20-40k": "$20,000–40,000", ">40k": "> $40,000" };
  const kids17 = intake.dependents.filter((d) => new Date().getFullYear() - 1 - d.birthYear < 17 && d.months > 6).length;
  const rows: Row[] = [
    base({ key: "identity", group: G.family, concept: { es: "Su nombre e identificación", en: "Your name and ID", pt: "Seu nome e identificação" }, cite: "1040 · p.1", declaration: `****${v.ssn_last4 ?? "—"}`, compareLabel: toldL, compare: `${intake.name} · ****${intake.last4}`, told: `${intake.name} · ****${intake.last4}` }),
    base({ key: "dependents", group: G.family, concept: { es: "Personas a su cargo", en: "Dependents", pt: "Dependentes" }, cite: "1040 · Dependents · p.1", declaration: String(v.dependents_count ?? "—"), compareLabel: toldL, compare: String(kids), told: String(kids) }),
    base({ key: "wages", group: G.earned, concept: { es: "Salarios (W-2)", en: "Wages (W-2)", pt: "Salários (W-2)" }, cite: "1040 · line 1z", declaration: $(v.wages), compareLabel: papersL, compare: $(intake.w2Wages), papers: $(intake.w2Wages) }, intake.w2Wages != null),
    base({ key: "self_employment", group: G.earned, concept: { es: "Negocio propio (Schedule C)", en: "Own business (Schedule C)", pt: "Negócio próprio (Schedule C)" }, cite: "Schedule C · line 31", declaration: $(v.schedule_c_net), compareLabel: toldL, compare: SE[intake.selfEmployed], told: SE[intake.selfEmployed] }),
    base({ key: "withholding", group: G.earned, concept: { es: "Impuestos ya retenidos", en: "Tax already withheld", pt: "Impostos já retidos" }, cite: "1040 · line 25d", declaration: $(v.withholding), compareLabel: papersL, compare: $(intake.w2Withholding), papers: $(intake.w2Withholding), f8879: $(v.f8879_withholding) }, intake.w2Withholding != null),
    base({ key: "eitc", group: G.credits, concept: { es: "Crédito por trabajo (EITC)", en: "Earned income credit (EITC)", pt: "Crédito por trabalho (EITC)" }, cite: "1040 · line 27", declaration: $(v.eitc), compareLabel: toldL, compare: L({ es: `Trabaja (W-2 y por su cuenta) · ${intake.idType}`, en: `Works (W-2 and self-employed) · ${intake.idType}`, pt: `Trabalha (W-2 e por conta própria) · ${intake.idType}` }), told: intake.idType }),
    base({ key: "ctc", group: G.credits, concept: { es: "Crédito por hijos (CTC)", en: "Child tax credit (CTC)", pt: "Crédito por filhos (CTC)" }, cite: "1040 · lines 19 + 28", declaration: $((v.ctc ?? 0) + (v.actc ?? 0)), compareLabel: toldL, compare: L({ es: `${kids17} hijos menores de 17`, en: `${kids17} children under 17`, pt: `${kids17} filhos menores de 17` }), told: `${kids}` }),
    base({ key: "credits_other", group: G.credits, concept: { es: "Otros créditos", en: "Other credits", pt: "Outros créditos" }, cite: "8863 · 4136 · 5695 · 8936", declaration: $((v.aotc ?? 0) + (v.fuel_credit_4136 ?? 0)), compareLabel: toldL, compare: intake.expenses.join(", ") || "—", told: intake.expenses.join(", ") || "—" }),
    base({ key: "refund", group: G.refund, concept: { es: "Monto del reembolso", en: "Refund amount", pt: "Valor do reembolso" }, cite: "1040 · line 35a", declaration: $(v.refund), compareLabel: f8879L, compare: $(v.f8879_refund), f8879: $(v.f8879_refund) }),
    base({ key: "refund_account", group: G.refund, concept: { es: "Cuenta donde llega", en: "Account it goes to", pt: "Conta de destino" }, cite: "1040 · lines 35b–d", declaration: `****${v.refund_acct_last4 ?? "—"} (${acct(v.refund_acct_type)})`, compareLabel: toldL, compare: `****${intake.refundAcctLast4} (${acct(intake.refundAcctType)})`, told: `****${intake.refundAcctLast4}` }),
    base({ key: "f8879", group: G.refund, concept: { es: "Hoja de autorización (8879)", en: "Authorization form (8879)", pt: "Formulário de autorização (8879)" }, cite: "8879 · Part I", declaration: v.f8879_present ? $(v.f8879_refund) : "—", compareLabel: { es: "Su declaración", en: "Your return", pt: "Sua declaração" }, compare: $(v.refund) }),
    base({ key: "preparer", group: G.prep, concept: { es: "Firma y PTIN del preparador", en: "Preparer signature and PTIN", pt: "Assinatura e PTIN do preparador" }, cite: "1040 · Paid Preparer · p.2", declaration: v.preparer_signed ? `${v.preparer_name ?? ""} · ${v.ptin ?? "—"}` : "—", compareLabel: { es: "PTIN del preparador en la plataforma", en: "Preparer PTIN on the platform", pt: "PTIN do preparador na plataforma" }, compare: v.ptin ?? "—" }),
  ];
  if (post) {
    // After filing the table compares what she APPROVED with what the IRS issued and what reached her bank.
    const snap = post.snapshot;
    const approved = snap.refund ?? v.refund;
    const r = rows.find((x) => x.key === "refund")!;
    r.declaration = $(approved);
    r.irs = v.tx_846 !== undefined ? $(v.tx_846) : L({ es: "pendiente", en: "pending", pt: "pendente" });
    r.bank = $(v.deposit_received);
    const short = approved !== undefined && v.deposit_received !== undefined && v.deposit_received + 1400 < approved;
    if (short && !r.findings.some((f) => f.severity === "IMPORTANT")) {
      const gap = approved! - v.deposit_received!;
      const f: Finding = {
        rule: "R14",
        severity: "IMPORTANT",
        rowKey: "refund",
        message: {
          es: `Usted aprobó ${$(approved)}; a su cuenta llegaron ${$(v.deposit_received)}. Faltan ${$(gap)}.`,
          en: `You approved ${$(approved)}; ${$(v.deposit_received)} reached your account. ${$(gap)} is missing.`,
          pt: `Você aprovou ${$(approved)}; chegaram ${$(v.deposit_received)} na sua conta. Faltam ${$(gap)}.`,
        },
      };
      r.findings = [...r.findings, f];
    }
    if (short || r.findings.some((f) => f.severity === "IMPORTANT")) r.status = "DIFFERENT";
    const a = rows.find((x) => x.key === "refund_account")!;
    const mine = snap.refund_acct_last4 ?? v.refund_acct_last4 ?? intake.refundAcctLast4;
    a.declaration = `****${mine} (${acct(snap.refund_acct_type ?? v.refund_acct_type)})`;
    if (post.split) {
      const s = post.split;
      a.irs = `****${s.mainAcct} ${$(s.mainAmount)} + ****${s.acct} ${$(s.amount)}`;
      a.bank = `****${mine} ${$(v.deposit_received)}`;
      a.status = "DIFFERENT";
      a.findings = [
        ...a.findings,
        {
          rule: "R14",
          severity: "IMPORTANT",
          rowKey: "refund_account",
          message: {
            es: `La declaración presentada llevaba un Formulario 8888 que mandó ${$(s.amount)} a ****${s.acct}. La versión que usted aprobó lo enviaba todo a ****${mine}.`,
            en: `The filed return carried a Form 8888 that sent ${$(s.amount)} to ****${s.acct}. The version you approved sent everything to ****${mine}.`,
            pt: `A declaração enviada tinha um Formulário 8888 que mandou ${$(s.amount)} para ****${s.acct}. A versão que você aprovou enviava tudo para ****${mine}.`,
          },
        },
      ];
    } else if (v.deposit_received !== undefined) a.bank = `****${mine}`;
  }
  return rows;
}
