"use client";
import { useEffect, useState } from "react";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import { useCase, usd, tr, fill, type Lang, type CaseView } from "./useCase";
import { ConciliationGrid } from "./ConciliationGrid";
import { ChatPanel, Avatar } from "./ChatPanel";
import { Bell, LangPicker, Banner, Logo, Stepper, Stamp, ListenButton, Refusal } from "./Bits";
import { S, FRAUD_COPY, VOICE_COPY } from "@/lib/i18n";
import type { Row } from "@/lib/rows";
import { AGENT_NAME } from "@/lib/brand";
import { MARIA_INTAKE, SAMPLE_PDF } from "@/lib/fixtures";
import { Consent7216 } from "./Consent7216";
import type { Intake } from "@/lib/rules";

const EMPTY_INTAKE: Intake = { name: "", last4: "", idType: "SSN", dependents: [], w2Wages: null, w2Withholding: null, selfEmployed: "none", expenses: [], refundAcctLast4: "", refundAcctType: "checking", payMethod: "separate" };

const LOCALE: Record<Lang, string> = { es: "es_US", en: "en_US", pt: "pt_BR" };
const POST_STATES = ["AUTHORIZED", "TRANSMITTED", "CAPTURE_PENDING", "CAPTURED", "INVESTIGATING", "REFUND_PROPOSED", "REFUND_PENDING", "REFUNDED", "REFUND_FAILED", "VOIDED", "VOID_PENDING", "VOID_FAILED", "CLOSED", "UNRESOLVED", "UNPAID"];
type Act = (t: string, e?: Record<string, unknown>) => Promise<Record<string, unknown>>;

type Fraud = { bad: string; mine: string; refund: string };
/** Prevention moment: R3 says the refund would land in an account that is not the client's. */
function fraudOf(v: CaseView): Fraud | null {
  if (!v.findings.some((x) => x.rule === "R3" && x.severity === "IMPORTANT")) return null;
  const bad = v.rows.find((r) => r.key === "refund_account")?.declaration.match(/\*{4}([0-9A-Za-z]{2,4})/)?.[1];
  const mine = v.intake?.refundAcctLast4;
  if (!bad || !mine || bad === mine) return null; // same account, other type: the ordinary review banner explains it
  return { bad, mine, refund: v.rows.find((r) => r.key === "refund")?.declaration ?? "—" };
}
const pdfFor = (v: CaseView) => (/carlos/i.test(v.clientName) ? SAMPLE_PDF.carlos : v.scenario === "seat-fraud" && fraudOf(v) ? SAMPLE_PDF.fraud : SAMPLE_PDF.maria);

function stepIndex(state: string) {
  if (["CASE_CREATED", "CONSENTED", "PROCESSING", "CLARIFY", "DIFFERENCES", "NEEDS_CONFIRMATION"].includes(state)) return 0;
  if (state === "MATCH") return 1;
  if (["AUTHORIZED", "TRANSMITTED", "CAPTURE_PENDING"].includes(state)) return 2;
  if (["CLOSED", "REFUNDED", "VOIDED"].includes(state)) return 4;
  return 3;
}

export function ClientApp({ token }: { token: string; compact?: boolean }) {
  const { data: v, error, act } = useCase(token);
  if (error) return <div className="p-10 text-ink-soft">{error}</div>;
  if (!v) return <div className="p-10 text-ink-soft">…</div>;
  const lang = v.lang as Lang;
  const steps = [
    tr({ es: "Revisar", en: "Review", pt: "Revisar" }, lang),
    tr({ es: "Aprobar", en: "Approve", pt: "Aprovar" }, lang),
    tr({ es: "Presentar", en: "File", pt: "Enviar" }, lang),
    tr({ es: "Reembolso", en: "Refund", pt: "Reembolso" }, lang),
  ];
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-8 sm:py-3.5">
          <Logo sub={tr({ es: `Su declaración con ${v.preparer.name}`, en: `Your return with ${v.preparer.name}`, pt: `Sua declaração com ${v.preparer.name}` }, lang)} />
          <div className="mx-auto hidden xl:block">
            <Stepper steps={steps} current={stepIndex(v.state)} />
          </div>
          <LangPicker lang={lang} onChange={(l) => act("set_lang", { lang: l })} />
          <Bell items={v.notifications} lang={lang} onOpen={() => act("mark_read")} />
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-8 sm:py-8">
        <Screen v={v} lang={lang} act={act} token={token} />
      </main>
      <footer className="mx-auto max-w-[1400px] px-4 pb-10 text-xs text-ink-soft sm:px-8">
        🔒 {tr(S.antiPhishing, lang)} · {tr({ es: "Ayuda gratuita", en: "Free help", pt: "Ajuda gratuita" }, lang)}: VITA · Taxpayer Advocate · 211
      </footer>
    </div>
  );
}

function Screen({ v, lang, act, token }: { v: CaseView; lang: Lang; act: Act; token: string }) {
  if (v.state === "CASE_CREATED") return <Welcome v={v} lang={lang} act={act} />;
  if (v.state === "CONSENTED")
    return (
      <Centered>
        <div className="font-display text-3xl font-semibold">{tr({ es: "¡Listo! Ya tenemos sus respuestas.", en: "Done! We have your answers.", pt: "Pronto! Já temos suas respostas." }, lang)}</div>
        <p className="mt-3 text-lg text-ink-soft">
          {tr({ es: `Cuando ${v.preparer.name} suba su declaración, verá un aviso en la campana. Puede cerrar esta página.`, en: `When ${v.preparer.name} uploads your return, you'll see it in the bell. You can close this page.`, pt: `Quando ${v.preparer.name} enviar sua declaração, você verá um aviso no sino. Pode fechar esta página.` }, lang)}
        </p>
      </Centered>
    );
  if (v.state === "PROCESSING")
    return (
      <Centered>
        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-line border-t-ink" />
        <div className="font-display text-2xl">{tr({ es: "Leyendo su declaración…", en: "Reading your return…", pt: "Lendo sua declaração…" }, lang)}</div>
      </Centered>
    );
  if (POST_STATES.includes(v.state)) return <Tracking v={v} lang={lang} act={act} token={token} />;
  return <Result v={v} lang={lang} act={act} token={token} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="card mx-auto mt-6 max-w-2xl px-6 py-10 text-center sm:mt-10 sm:px-10 sm:py-14">{children}</div>;
}

function Welcome({ v, lang, act }: { v: CaseView; lang: Lang; act: Act }) {
  const vars = { prep: v.preparer.name, fee: usd(v.fee) };
  const trust = [
    tr({ es: "No somos el IRS ni el gobierno", en: "We are not the IRS or the government", pt: "Não somos o IRS nem o governo" }, lang),
    tr({ es: "Funciona con SSN o ITIN; no preguntamos estatus migratorio", en: "Works with SSN or ITIN; we never ask immigration status", pt: "Funciona com SSN ou ITIN; não perguntamos situação migratória" }, lang),
    tr({ es: "Solo se cobra cuando el IRS confirma que recibió su declaración", en: "Charged only when the IRS confirms it received your return", pt: "Só é cobrado quando o IRS confirma o recebimento" }, lang),
  ];
  const [f, setF] = useState<Intake>({ ...EMPTY_INTAKE, name: v.clientName });
  const [err, setErr] = useState<string | null>(null);
  const t = (es: string, en: string, pt: string) => tr({ es, en, pt }, lang);
  const set = <K extends keyof Intake>(k: K, val: Intake[K]) => setF((x) => ({ ...x, [k]: val }));
  const dollars = (c?: number | null) => (c == null ? "" : String(c / 100));
  const cents = (x: string) => (x.trim() === "" ? null : Math.round(Number(x.replace(/[$,]/g, "")) * 100));
  const valid = f.name.trim().length > 2 && /^\d{4}$/.test(f.last4) && /^\d{4}$/.test(f.refundAcctLast4) && f.dependents.every((d) => d.relation && d.birthYear > 1900 && d.months >= 0 && d.months <= 12);
  const [step, setStep] = useState<"form" | "consent">("form");
  const submit = async (consent: Record<string, unknown>) => {
    setErr(null);
    const r = await act("submit_intake", { intake: f, consents: { review: true, other: false, ...consent } });
    if ((r as { error?: string }).error) {
      setErr(String((r as { error?: string }).error));
      setStep("form");
    }
  };
  const field = "mt-1 w-full rounded-md border-[1.5px] border-ink/25 bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-ink";
  const lab = "block text-xs font-semibold uppercase tracking-wider text-ink-soft";
  if (step === "consent")
    return <Consent7216 lang={lang} client={f.name || v.clientName} preparer={v.preparer.name} business={v.preparer.business} onBack={() => setStep("form")} onSign={(c) => submit(c)} />;
  return (
    <div className="grid items-start gap-8 pt-2 lg:grid-cols-[1.1fr_1fr] lg:gap-12 lg:pt-4">
      <div className="min-w-0">
        <div className="eyebrow">{tr({ es: `Hola, ${v.clientName.split(" ")[0]}`, en: `Hi, ${v.clientName.split(" ")[0]}`, pt: `Olá, ${v.clientName.split(" ")[0]}` }, lang)}</div>
        <h1 className="mt-3 font-display text-3xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-4xl lg:text-5xl">{tr(S.welcomeTitle, lang)}</h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">{fill(tr(S.welcomeMoney, lang), vars)}</p>
        <ul className="mt-8 space-y-3">
          {trust.map((t) => (
            <li key={t} className="flex items-start gap-3 text-[15px] text-ink">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-mark text-xs font-bold text-ink">✓</span>
              {t}
            </li>
          ))}
        </ul>
        <div className="mt-8 flex items-center gap-3 rounded-md border-[1.5px] border-ink/25 bg-sheet px-4 py-3">
          <Avatar who={v.preparer.name[0]} />
          <div className="text-sm">
            <div className="font-semibold text-ink">
              {v.preparer.name} · {v.preparer.business}
            </div>
            <div className="text-ink-soft">{fill(tr(S.ptinNote, lang), vars)}</div>
          </div>
        </div>
      </div>
      <div className="card min-w-0 p-5 sm:p-7">
        <div className="flex items-center justify-between gap-3">
          <div className="eyebrow">{t("Su entrevista", "Your interview", "Sua entrevista")}</div>
          <button type="button" onClick={() => setF({ ...MARIA_INTAKE, name: v.clientName })} className="text-xs font-semibold text-brand underline underline-offset-2">
            {t("Rellenar con un ejemplo", "Fill with an example", "Preencher com um exemplo")}
          </button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className={lab}>{t("Nombre completo", "Full name", "Nome completo")}</span>
            <input className={field} value={f.name} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label>
            <span className={lab}>{t("Identificación", "Tax ID", "Identificação")}</span>
            <select className={field} value={f.idType} onChange={(e) => set("idType", e.target.value as Intake["idType"])}>
              <option>SSN</option>
              <option>ITIN</option>
            </select>
          </label>
          <label>
            <span className={lab}>{t("Últimos 4 dígitos", "Last 4 digits", "Últimos 4 dígitos")}</span>
            <input className={field} inputMode="numeric" maxLength={4} value={f.last4} onChange={(e) => set("last4", e.target.value.replace(/\D/g, ""))} placeholder="0000" />
          </label>
        </div>
        <div className="mt-5">
          <div className={lab}>{t("Personas a su cargo · relación, año de nacimiento, meses que vivió con usted", "People you support · relation, birth year, months lived with you", "Pessoas sob sua responsabilidade · relação, ano de nascimento, meses com você")}</div>
          <div className="mt-1 space-y-2">
            {f.dependents.map((d, i) => (
              <div key={i} className="grid grid-cols-[1.3fr_1fr_1.2fr_auto] items-center gap-2">
                <input className={field + " mt-0"} value={d.relation} placeholder={t("hija, sobrino…", "daughter, nephew…", "filha, sobrinho…")} onChange={(e) => set("dependents", f.dependents.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)))} />
                <input className={field + " mt-0"} inputMode="numeric" maxLength={4} value={d.birthYear || ""} placeholder={t("año nac.", "birth year", "ano nasc.")} onChange={(e) => set("dependents", f.dependents.map((x, j) => (j === i ? { ...x, birthYear: Number(e.target.value.replace(/\D/g, "")) } : x)))} />
                <select className={field + " mt-0"} value={d.months} onChange={(e) => set("dependents", f.dependents.map((x, j) => (j === i ? { ...x, months: Number(e.target.value) } : x)))}>
                  {Array.from({ length: 13 }, (_, m) => (
                    <option key={m} value={m}>
                      {m} {t("meses", "months", "meses")}
                    </option>
                  ))}
                </select>
                <button type="button" aria-label="remove" onClick={() => set("dependents", f.dependents.filter((_, j) => j !== i))} className="px-2 text-lg text-ink-soft hover:text-ink">×</button>
              </div>
            ))}
            <button type="button" onClick={() => set("dependents", [...f.dependents, { relation: "", birthYear: 0, months: 12, country: "US" }])} className="text-sm font-semibold text-brand">
              + {t("Añadir persona", "Add person", "Adicionar pessoa")}
            </button>
          </div>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label>
            <span className={lab}>{t("Salario en su W-2 ($)", "Wages on your W-2 ($)", "Salário no seu W-2 ($)")}</span>
            <input className={field} inputMode="decimal" value={dollars(f.w2Wages)} onChange={(e) => set("w2Wages", cents(e.target.value))} placeholder="—" />
          </label>
          <label>
            <span className={lab}>{t("Impuesto retenido en su W-2 ($)", "Tax withheld on your W-2 ($)", "Imposto retido no W-2 ($)")}</span>
            <input className={field} inputMode="decimal" value={dollars(f.w2Withholding)} onChange={(e) => set("w2Withholding", cents(e.target.value))} placeholder="—" />
          </label>
          <label>
            <span className={lab}>{t("Ganancia trabajando por su cuenta", "Self-employed earnings", "Ganhos por conta própria")}</span>
            <select className={field} value={f.selfEmployed} onChange={(e) => set("selfEmployed", e.target.value as Intake["selfEmployed"])}>
              <option value="none">{t("No trabajo por mi cuenta", "None", "Nenhum")}</option>
              <option value="<10k">&lt; $10,000</option>
              <option value="10-20k">$10,000–20,000</option>
              <option value="20-40k">$20,000–40,000</option>
              <option value=">40k">&gt; $40,000</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-ink">
            <input type="checkbox" className="h-4 w-4 accent-brand" checked={f.expenses.includes("education")} onChange={(e) => set("expenses", e.target.checked ? ["education"] : [])} />
            {t("Pagué estudios universitarios", "I paid college tuition", "Paguei faculdade")}
          </label>
          <label>
            <span className={lab}>{t("Cuenta del reembolso · últimos 4", "Refund account · last 4", "Conta do reembolso · últimos 4")}</span>
            <input className={field} inputMode="numeric" maxLength={4} value={f.refundAcctLast4} onChange={(e) => set("refundAcctLast4", e.target.value.replace(/\D/g, ""))} placeholder="0000" />
          </label>
          <label>
            <span className={lab}>{t("Tipo de cuenta", "Account type", "Tipo de conta")}</span>
            <select className={field} value={f.refundAcctType} onChange={(e) => set("refundAcctType", e.target.value as Intake["refundAcctType"])}>
              <option value="checking">{t("Corriente", "Checking", "Corrente")}</option>
              <option value="savings">{t("Ahorros", "Savings", "Poupança")}</option>
            </select>
          </label>
        </div>
        <p className="mt-5 text-xs leading-relaxed text-ink-soft">{tr(S.privacy, lang)}</p>
        {err && <div className="mt-3 text-sm text-diff">{err}</div>}
        <button disabled={!valid} onClick={() => setStep("consent")} className="btn-primary mt-5 w-full py-3.5 text-base">
          {t("Continuar", "Continue", "Continuar")} →
        </button>
        {!valid && (
          <div className="mt-2 text-center text-xs text-ink-soft">
            {t("Falta:", "Missing:", "Falta:")}{" "}
            {[
              f.name.trim().length > 2 ? null : t("nombre", "name", "nome"),
              /^\d{4}$/.test(f.last4) ? null : t("últimos 4 dígitos", "last 4 digits", "últimos 4 dígitos"),
              /^\d{4}$/.test(f.refundAcctLast4) ? null : t("cuenta del reembolso", "refund account", "conta do reembolso"),
              f.dependents.every((d) => d.relation && d.birthYear > 1900) ? null : t("relación y año de cada persona", "relation and birth year of each person", "relação e ano de cada pessoa"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

function Summary({ v, lang, right, fraud }: { v: CaseView; lang: Lang; right?: React.ReactNode; fraud?: Fraud | null }) {
  const get = (k: string) => v.rows.find((r) => r.key === k);
  const speech = fill(tr(VOICE_COPY.summary, lang), { refund: get("refund")?.declaration ?? "—", acct: (get("refund_account")?.declaration ?? "—").replace(/\*{4}/, lang === "en" ? "ending in " : lang === "pt" ? "final " : "terminada en "), prep: v.preparer.name, fee: usd(v.fee) });
  const facts: [string, string, string?][] = [
    [tr({ es: "Personas a su cargo", en: "Dependents", pt: "Dependentes" }, lang), get("dependents")?.declaration ?? "—"],
    [tr({ es: "Preparada por", en: "Prepared by", pt: "Preparada por" }, lang), v.preparer.name, get("preparer")?.declaration.split("·")[1]?.trim()],
    [tr({ es: "Tarifa del preparador", en: "Preparer fee", pt: "Taxa do preparador" }, lang), usd(v.fee)],
  ];
  return (
    <div className="card grid overflow-hidden md:grid-cols-[280px_1fr] lg:grid-cols-[340px_1fr]">
      <div className="relative border-b-[1.5px] border-ink bg-ink px-5 py-5 text-sheet sm:px-7 sm:py-6 md:border-b-0 md:border-r-[1.5px]">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-sheet/60 font-mono">{tr({ es: "Su reembolso federal", en: "Your federal refund", pt: "Seu reembolso federal" }, lang)}</div>
        <div className="mt-1 font-display text-5xl tabular-nums sm:text-6xl"><span className="text-mark">{get("refund")?.declaration ?? "—"}</span></div>
        {fraud ? (
          <div className="mt-2 text-sm text-white/80">
            {tr({ es: "a la cuenta", en: "to account", pt: "para a conta" }, lang)}{" "}
            <span className="rounded-sm bg-diff px-1.5 py-0.5 font-mono font-bold text-sheet">****{fraud.bad}</span>{" "}
            <span className="font-semibold text-[#ff9a85]">← {tr(FRAUD_COPY.notYours, lang)}</span>
          </div>
        ) : (
          <div className="mt-2 text-sm text-white/70">
            {tr({ es: "a su cuenta", en: "to your account", pt: "para sua conta" }, lang)} {get("refund_account")?.declaration}
          </div>
        )}
        <div className="mt-3">
          <ListenButton text={fraud ? `${speech} ${fill(tr(FRAUD_COPY.body, lang), { refund: fraud.refund, bad: fraud.bad, mine: fraud.mine })}` : speech} lang={lang} small dark />
        </div>
      </div>
      <div className="flex flex-col items-start justify-between gap-5 px-5 py-5 sm:px-7 xl:flex-row xl:items-center">
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          {facts.map(([k, val, sub]) => (
            <div key={k} className="whitespace-nowrap">
              <div className="eyebrow">{k}</div>
              <div className="mt-1 text-xl font-semibold text-ink">{val}</div>
              {sub && <div className="text-xs text-ink-soft">PTIN {sub}</div>}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-5">
          {v.payment?.status && v.payment.status !== "CREATED" && <Stamp status={v.payment.status} label={STAMP_L[v.payment.status]?.[lang]} />}
          {right}
        </div>
      </div>
    </div>
  );
}

const STAMP_L: Record<string, Record<Lang, string>> = {
  AUTHORIZED: { es: "Apartado", en: "Held", pt: "Reservado" },
  COMPLETED: { es: "Pagado", en: "Paid", pt: "Pago" },
  VOIDED: { es: "Anulado", en: "Void", pt: "Anulado" },
  REFUNDED: { es: "Devuelto", en: "Refunded", pt: "Devolvido" },
};

function Workspace({ v, lang, act, token, children, alertRow }: { v: CaseView; lang: Lang; act: Act; token: string; children?: React.ReactNode; alertRow?: string | null }) {
  const [tab, setTab] = useState<"chat" | "doc">("chat");
  const [sel, setSel] = useState<Row | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[1fr_400px]">
      <div className="min-w-0 space-y-5">
        {children}
        <ConciliationGrid token={token} rows={v.rows} lang={lang} focusRow={focus} alertRow={alertRow} onSelect={(r) => { setSel(r); setTab("doc"); }} />
      </div>
      <aside className="card min-w-0 overflow-hidden xl:sticky xl:top-24">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <Avatar who={AGENT_NAME[0]} agent />
          <div className="leading-tight">
            <div className="font-semibold text-ink">{AGENT_NAME}</div>
            <div className="text-xs text-ink-soft">{tr({ es: "Responde con sus documentos · no da asesoría fiscal", en: "Answers from your documents · no tax advice", pt: "Responde com seus documentos · sem consultoria fiscal" }, lang)}</div>
          </div>
        </div>
        <div className="flex border-b border-line">
          <button onClick={() => setTab("chat")} className={`tab ${tab === "chat" ? "tab-on" : ""}`}>{tr(S.askClara, lang)}</button>
          <button onClick={() => setTab("doc")} className={`tab ${tab === "doc" ? "tab-on" : ""}`}>{tr(S.inDoc, lang)}</button>
        </div>
        {tab === "chat" ? (
          <ChatPanel v={v} lang={lang} onSend={(t) => act("chat", { text: t })} onSendQuestions={(id) => act("send_questions", { id })} onFocus={(r) => setFocus(`${r.replace("~auto", "")}:${Date.now()}${r.endsWith("~auto") ? ":auto" : ""}`)} />
        ) : (
          <div className="space-y-4 p-5 text-sm">
            {sel ? (
              <>
                <div>
                  <div className="eyebrow">{sel.cite}</div>
                  <div className="mt-1 font-display text-2xl font-semibold">{tr(sel.concept, lang)}</div>
                </div>
                <div className="rounded-md bg-paper p-4">
                  <div className="eyebrow">{tr({ es: "Su declaración dice", en: "Your return says", pt: "Sua declaração diz" }, lang)}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">{sel.declaration}</div>
                  <div className="mt-2 text-ink-soft">
                    {tr(sel.compareLabel, lang)}: <span className="font-medium text-ink">{sel.compare}</span>
                  </div>
                </div>
                {sel.findings.map((f, i) => (
                  <div key={i} className="rounded-md border border-diff/25 bg-diff-soft p-3 text-ink">
                    <span className="font-semibold text-diff">[{f.rule}]</span> {tr(f.message, lang)}
                  </div>
                ))}
                <div className="flex flex-col gap-2">
                  <a className="btn-secondary text-sm" href={pdfFor(v)} target="_blank">
                    {tr({ es: "Abrir el PDF de su declaración", en: "Open your return PDF", pt: "Abrir o PDF da declaração" }, lang)}
                  </a>
                  <button
                    onClick={() => {
                      setTab("chat");
                      act("chat", { text: tr({ es: `¿Qué significa "${tr(sel.concept, "es")}"?`, en: `What does "${tr(sel.concept, "en")}" mean?`, pt: `O que significa "${tr(sel.concept, "pt")}"?` }, lang) });
                    }}
                    className="btn-primary text-sm"
                  >
                    {tr({ es: "Preguntar a Clara sobre esto", en: "Ask Clara about this", pt: "Perguntar à Clara sobre isso" }, lang)}
                  </button>
                </div>
              </>
            ) : (
              <div className="py-10 text-center text-ink-soft">{tr({ es: "Haga clic en una fila de la tabla para ver de dónde sale cada dato.", en: "Click a row to see where each value comes from.", pt: "Clique em uma linha para ver de onde vem cada dado." }, lang)}</div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Result({ v, lang, act, token }: { v: CaseView; lang: Lang; act: Act; token: string }) {
  const [approving, setApproving] = useState(false);
  const total = v.rows.length;
  const conf = v.confirmed ?? 0;
  const ok = v.rows.filter((r) => r.status === "MATCH").length;
  const nc = v.rows.filter((r) => r.status === "NOCHECK").length;
  const vars = { prep: v.preparer.name, fee: usd(v.fee), n: total, ok, conf: conf ? tr({ es: ` · ${conf} confirmada por usted`, en: ` · ${conf} confirmed by you`, pt: ` · ${conf} confirmada por você` }, lang) : "", nc: nc ? ` · ${nc} ${tr({ es: "sin papel", en: "without papers", pt: "sem documento" }, lang)}` : "" };
  const fraud = fraudOf(v);
  const approveBtn = fraud ? (
    <div className="flex shrink-0 flex-col items-start gap-1.5">
      <Stamp status="NOT_APPROVED" label={tr(FRAUD_COPY.stamp, lang)} />
      <span className="text-xs font-semibold text-diff">{tr(FRAUD_COPY.heldNothing, lang)} · {usd(0)}</span>
    </div>
  ) : (
    <div className="flex shrink-0 flex-col items-start gap-1.5">
      <button disabled={v.state !== "MATCH"} onClick={() => setApproving(true)} className="btn-primary px-6 py-3.5 text-base">
        {fill(tr(S.approve, lang), vars)}
      </button>
      <span className="text-xs text-ink-soft">
        {v.state === "MATCH"
          ? tr({ es: "Hoy no se cobra nada: PayPal solo lo aparta.", en: "Nothing is charged today: PayPal only holds it.", pt: "Nada é cobrado hoje: o PayPal só reserva." }, lang)
          : tr({ es: "↓ Primero aclare el punto marcado abajo.", en: "↓ First clear up the item marked below.", pt: "↓ Primeiro esclareça o ponto marcado abaixo." }, lang)}
      </span>
    </div>
  );
  return (
    <div className="min-w-0 space-y-6">
      <Summary v={v} lang={lang} right={approveBtn} fraud={fraud} />
      <Workspace v={v} lang={lang} act={act} token={token} alertRow={fraud ? "refund_account" : null}>
        {fraud ? (
          <FraudAlert v={v} lang={lang} act={act} fraud={fraud} />
        ) : v.state === "MATCH" ? (
          <Banner tone="ok" title={fill(tr(S.matchTitle, lang), vars)}>
            {tr(S.notAdvisor, lang)}{" "}
            <a className="font-medium text-brand underline" href={pdfFor(v)} target="_blank">
              {tr({ es: "Descargar mi declaración (PDF)", en: "Download my return (PDF)", pt: "Baixar minha declaração (PDF)" }, lang)}
            </a>
          </Banner>
        ) : (
          <Banner tone="warn" title={fill(tr(v.state === "CLARIFY" ? S.clarifyTitle : S.diffTitle, lang), { ...vars, agent: AGENT_NAME, n: v.findings.length })}>
            {v.findings.slice(0, 2).map((f, i) => (
              <div key={i} className="mt-1 font-semibold text-ink">→ {tr(f.message, lang)}</div>
            ))}
            {v.state === "CLARIFY" && (
              <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-ink">
                <li>{tr({ es: `Lea la explicación de ${AGENT_NAME} (a la derecha).`, en: `Read ${AGENT_NAME}'s explanation (on the right).`, pt: `Leia a explicação de ${AGENT_NAME} (à direita).` }, lang)}</li>
                <li>{tr({ es: `Pregúntele a ${v.preparer.name.split(" ")[0]}: ${AGENT_NAME} le redacta la pregunta y usted la envía.`, en: `Ask ${v.preparer.name.split(" ")[0]}: ${AGENT_NAME} drafts the question and you send it.`, pt: `Pergunte a ${v.preparer.name.split(" ")[0]}: ${AGENT_NAME} escreve a pergunta e você envia.` }, lang)}</li>
                <li>{tr({ es: "Cuando esté claro, confírmelo para poder aprobar.", en: "Once it's clear, confirm it so you can approve.", pt: "Quando estiver claro, confirme para poder aprovar." }, lang)}</li>
              </ol>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {v.state === "CLARIFY" && (
                <button
                  onClick={() =>
                    act("chat", {
                      text: tr({ es: `Ayúdeme a preguntarle a ${v.preparer.name} por esta diferencia.`, en: `Help me ask ${v.preparer.name} about this difference.`, pt: `Me ajude a perguntar a ${v.preparer.name} sobre esta diferença.` }, lang),
                    })
                  }
                  className="btn-primary py-1.5 text-sm"
                >
                  {tr({ es: `Preguntar a ${v.preparer.name.split(" ")[0]}`, en: `Ask ${v.preparer.name.split(" ")[0]}`, pt: `Perguntar a ${v.preparer.name.split(" ")[0]}` }, lang)}
                </button>
              )}
              {v.state === "CLARIFY" && (
                <button onClick={() => act("accept_clarifications")} className="btn-secondary py-1.5 text-sm">
                  {tr({ es: `Ya lo confirmé con ${v.preparer.name.split(" ")[0]}: está correcto`, en: `I confirmed it with ${v.preparer.name.split(" ")[0]}: it's correct`, pt: `Já confirmei com ${v.preparer.name.split(" ")[0]}: está correto` }, lang)}
                </button>
              )}
            </div>
          </Banner>
        )}
        <PayPalSteps v={v} lang={lang} />
      </Workspace>
      {approving && <ApproveModal v={v} lang={lang} token={token} onClose={() => setApproving(false)} />}
    </div>
  );
}

/** The ghost-preparer fraud, stopped BEFORE signing: big, plain, read-aloud, with the next move. */
function FraudAlert({ v, lang, act, fraud }: { v: CaseView; lang: Lang; act: Act; fraud: Fraud }) {
  const [asked, setAsked] = useState(false);
  const prep = v.preparer.name.split(" ")[0];
  const vars = { refund: fraud.refund, bad: fraud.bad, mine: fraud.mine, prep, agent: AGENT_NAME };
  const T = (k: string) => fill(tr(FRAUD_COPY[k], lang), vars);
  const already = asked || v.chat.some((m) => m.role === "client" && m.text.includes(`****${fraud.bad}`));
  const speech = [T("title"), T("body"), T("held"), T("next"), T("step1"), T("step2"), T("step3")].join(" ");
  return (
    <section role="alert" data-fraud-alert className="rounded-md border-[2.5px] border-diff bg-diff-soft p-5 shadow-[4px_4px_0_0_var(--color-diff)] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] font-bold uppercase tracking-widest text-diff">
            {AGENT_NAME} · {T("before")}
          </div>
          <h2 className="mt-1 font-display text-3xl leading-tight text-ink sm:text-4xl">{T("title")}</h2>
        </div>
        <Stamp status="NOT_APPROVED" label={T("stamp")} />
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border-[1.5px] border-diff bg-sheet px-4 py-3">
          <div className="eyebrow text-diff">{T("returnSends")}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-diff">****{fraud.bad}</div>
          <div className="text-sm text-ink-soft">
            {fraud.refund} · {T("notYours")}
          </div>
        </div>
        <div className="rounded-md border-[1.5px] border-ok bg-sheet px-4 py-3">
          <div className="eyebrow text-ok">{T("yourAcct")}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-ok">****{fraud.mine}</div>
          <div className="text-sm text-ink-soft">{tr({ es: "la que usted nos dio", en: "the one you gave us", pt: "a que você nos deu" }, lang)}</div>
        </div>
      </div>
      <p className="mt-4 text-[17px] leading-relaxed text-ink">{T("body")}</p>
      <p className="mt-2 font-semibold text-ink">🔒 {T("held")}</p>
      <div className="eyebrow mt-4">{T("next")}</div>
      <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[15px] text-ink">
        <li>{T("step1")}</li>
        <li>{T("step2")}</li>
        <li>{T("step3")}</li>
      </ol>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          disabled={already}
          onClick={async () => {
            setAsked(true);
            await act("chat", { text: T("askFixText") });
          }}
          className="btn-primary py-2 text-sm"
        >
          {T("askFix")} →
        </button>
        <a className="btn-secondary py-2 text-sm" href="https://www.irs.gov/pub/irs-pdf/f14157.pdf" target="_blank" rel="noreferrer">
          {T("report")} ↗
        </a>
        <ListenButton text={speech} lang={lang} />
      </div>
      {already && <div className="mt-3 text-sm font-semibold text-ink">✓ {T("asked")}</div>}
    </section>
  );
}

function ApproveModal({ v, lang, token, onClose }: { v: CaseView; lang: Lang; token: string; onClose: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [fee, setFee] = useState<{ split: { kind: string; amount: number }[]; seat: boolean } | null>(null);
  const [seatBusy, setSeatBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/case/${token}/paypal`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setFee).catch(() => setFee(null));
  }, [token]);
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
  const date = new Date(new Date(v.now).getTime() + 5 * 86400_000).toLocaleDateString(lang === "en" ? "en-US" : lang === "pt" ? "pt-BR" : "es-US", { day: "numeric", month: "long" });
  const refund = v.rows.find((r) => r.key === "refund")?.declaration;
  const acct = v.rows.find((r) => r.key === "refund_account")?.declaration;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/40 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()} tabIndex={-1} ref={(el) => el?.focus()}>
      <div className="card mx-4 max-h-[92vh] w-full max-w-[520px] space-y-5 overflow-y-auto p-6 sm:p-8">
        <div>
          <div className="eyebrow">{tr({ es: "Aprobar su declaración", en: "Approve your return", pt: "Aprovar sua declaração" }, lang)}</div>
          <div className="mt-1 font-display text-3xl font-semibold">{tr({ es: "Apartar", en: "Set aside", pt: "Reservar" }, lang)} {usd(v.fee)}</div>
          <div className="mt-1 text-ink-soft">{tr({ es: "Hoy no se cobra nada.", en: "Nothing is charged today.", pt: "Nada é cobrado hoje." }, lang)}</div>
        </div>
        <div className="rounded-md bg-paper p-4 text-sm">
          <div className="flex justify-between"><span className="text-ink-soft">{tr({ es: "Reembolso que aprueba", en: "Refund you approve", pt: "Reembolso aprovado" }, lang)}</span><b>{refund}</b></div>
          <div className="mt-1 flex justify-between"><span className="text-ink-soft">{tr({ es: "A la cuenta", en: "To account", pt: "Para a conta" }, lang)}</span><b>{acct}</b></div>
          {fee && fee.split.length > 1 && (
            <div className="mt-2 border-t border-dashed border-ink/20 pt-2">
              {fee.split.map((l) => (
                <div key={l.kind} className="flex justify-between">
                  <span className="text-ink-soft">
                    {l.kind === "STATE"
                      ? tr({ es: "Declaración estatal — se cobra cuando el estado la acepta", en: "State return — charged when the state accepts it", pt: "Declaração estadual — cobrada quando o estado aceita" }, lang)
                      : tr({ es: "Declaración federal — se cobra cuando el IRS la acepta", en: "Federal return — charged when the IRS accepts it", pt: "Declaração federal — cobrada quando o IRS aceita" }, lang)}
                  </span>
                  <b className="font-mono">{usd(l.amount)}</b>
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="text-sm leading-relaxed text-ink-soft">{fill(tr(S.approveNote, lang), { prep: v.preparer.name, date })}</p>
        {!clientId && <Banner tone="warn">PayPal is not configured (NEXT_PUBLIC_PAYPAL_CLIENT_ID).</Banner>}
        {clientId && <PayPalScriptProvider options={{ clientId, intent: "authorize", currency: "USD", "disable-funding": "paylater,venmo", locale: LOCALE[lang] }}>
          <PayPalButtons
            style={{ layout: "vertical", label: "pay", shape: "rect", height: 48 }}
            createOrder={async () => {
              const r = await fetch(`/api/case/${token}/paypal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "create" }) });
              const j = await r.json();
              if (!j.orderId) throw new Error(JSON.stringify(j.blocked));
              return j.orderId;
            }}
            onApprove={async (data, actions) => {
              const r = await fetch(`/api/case/${token}/paypal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "authorize", orderID: data.orderID }) });
              const j = await r.json();
              if (j.issue === "INSTRUMENT_DECLINED") return actions.restart();
              if (!j.ok) setMsg(tr({ es: "No se pudo apartar el pago. No se le cobró nada.", en: "We couldn't set the payment aside. Nothing was charged.", pt: "Não foi possível reservar o pagamento. Nada foi cobrado." }, lang));
              else onClose();
            }}
            onCancel={() => setMsg(tr({ es: "Cerró PayPal. No se apartó nada.", en: "You closed PayPal. Nothing was set aside.", pt: "Você fechou o PayPal. Nada foi reservado." }, lang))}
            onError={() => setMsg(tr({ es: "PayPal no respondió. Si el navegador bloqueó la ventana emergente, permítala e intente de nuevo.", en: "PayPal didn't respond. If the pop-up was blocked, allow it and retry.", pt: "O PayPal não respondeu. Se o pop-up foi bloqueado, permita e tente de novo." }, lang))}
          />
        </PayPalScriptProvider>}
        {clientId && <SandboxHelp />}
        {fee?.seat && (
          <button
            disabled={seatBusy}
            onClick={async () => {
              setSeatBusy(true);
              const r = await fetch(`/api/case/${token}/paypal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "seat" }) });
              const j = await r.json().catch(() => ({}));
              setSeatBusy(false);
              if (j.ok) onClose();
              else setMsg(tr({ es: "No se pudo apartar con la billetera de prueba. No se le cobró nada.", en: "The test wallet couldn't set the payment aside. Nothing was charged.", pt: "A carteira de teste não conseguiu reservar o pagamento. Nada foi cobrado." }, lang));
            }}
            className="btn-secondary w-full text-sm"
          >
            {seatBusy ? "…" : tr({ es: "Asiento de jurado: aprobar con la billetera PayPal de prueba guardada", en: "Judge seat: approve with the saved PayPal test wallet", pt: "Assento de jurado: aprovar com a carteira PayPal de teste salva" }, lang)}
          </button>
        )}
        {msg && <Banner tone="warn">{msg}</Banner>}
        <button onClick={onClose} className="w-full text-center text-sm text-ink-soft hover:text-ink">
          {tr({ es: "Volver", en: "Back", pt: "Voltar" }, lang)}
        </button>
      </div>
    </div>
  );
}

/** Optional: shows the PayPal test buyer for reviewers when configured (public env vars, test account only). */
function SandboxHelp() {
  const email = process.env.NEXT_PUBLIC_SANDBOX_BUYER_EMAIL;
  const pass = process.env.NEXT_PUBLIC_SANDBOX_BUYER_PASSWORD;
  if (!email) return null;
  return (
    <div className="rounded-md border-[1.5px] border-dashed border-ink/40 px-4 py-2.5 text-xs text-ink-soft">
      Test buyer: <span className="select-all font-mono text-ink">{email}</span>
      {pass && <> · <span className="select-all font-mono text-ink">{pass}</span></>}
    </div>
  );
}

/** Where PayPal is in this case: the four possible money moves, with the current one marked. */
function PayPalSteps({ v, lang }: { v: CaseView; lang: Lang }) {
  const t = (es: string, en: string, pt: string) => tr({ es, en, pt }, lang);
  const st = v.payment?.status ?? "NONE";
  const steps: { k: string; on: boolean; done: boolean; t: string; d: string; id?: string | null }[] = [
    { k: "hold", on: st === "AUTHORIZED", done: ["AUTHORIZED", "COMPLETED", "REFUNDED", "VOIDED"].includes(st), t: t("Apartar al aprobar", "Hold when you approve", "Reservar ao aprovar"), d: t(`PayPal aparta ${usd(v.fee)}. No se cobra.`, `PayPal holds ${usd(v.fee)}. Not charged.`, `O PayPal reserva ${usd(v.fee)}. Não é cobrado.`), id: v.payment?.authorizationId },
    { k: "capture", on: st === "COMPLETED", done: ["COMPLETED", "REFUNDED"].includes(st), t: t("Cobrar cuando el IRS confirma", "Collect when the IRS confirms", "Cobrar quando o IRS confirma"), d: t(`${v.preparer.name.split(" ")[0]} recibe su pago solo con la confirmación del IRS.`, `${v.preparer.name.split(" ")[0]} is paid only with the IRS confirmation.`, `${v.preparer.name.split(" ")[0]} recebe só com a confirmação do IRS.`), id: v.payment?.captureId },
    { k: "void", on: st === "VOIDED", done: st === "VOIDED", t: t("Cancelar si no se presenta", "Cancel if never filed", "Cancelar se não for entregue"), d: t("Sin confirmación a tiempo, el apartado se libera solo.", "No confirmation in time: the hold is released automatically.", "Sem confirmação a tempo, a reserva é liberada.") },
    { k: "refund", on: st === "REFUNDED", done: st === "REFUNDED", t: t("Devolver si su reembolso se desvió", "Refund if your refund was diverted", "Devolver se o reembolso foi desviado"), d: t("Si el registro del IRS lo demuestra, le devolvemos la tarifa.", "If the IRS record shows it, your fee comes back.", "Se o registro do IRS mostrar, a taxa volta."), id: v.payment?.refundId },
  ];
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="eyebrow">{t("Su pago con PayPal", "Your payment with PayPal", "Seu pagamento com PayPal")}</div>
        {st !== "NONE" && st !== "CREATED" && <Stamp status={st} small label={STAMP_L[st]?.[lang]} />}
      </div>
      <ol className="mt-3 grid gap-3 sm:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.k} className={`rounded-md border-[1.5px] p-3 text-sm ${s.on ? "border-ink bg-mark/50" : s.done ? "border-ink/40" : "border-dashed border-ink/25 text-ink-soft"}`}>
            <div className="font-mono text-[10px] font-bold uppercase tracking-widest">{s.done ? "✓" : i + 1}</div>
            <div className="mt-0.5 font-semibold text-ink">{s.t}</div>
            <div className="mt-0.5 text-xs">{s.d}</div>
            {s.id && <div className="mt-1 truncate font-mono text-[10px] text-ink-soft">PayPal ID {s.id}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Tracking({ v, lang, act, token }: { v: CaseView; lang: Lang; act: Act; token: string }) {
  const [amount, setAmount] = useState("4729");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refused, setRefused] = useState<string[] | null>(null);
  const run = async (type: string, extra?: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setRefused(null);
    const r = await act(type, extra);
    if ((r as { error?: string }).error) setErr(String((r as { error?: string }).error));
    else if ((r as { ok?: boolean }).ok === false && (r as { blocked?: string[] }).blocked?.length) setRefused((r as { blocked: string[] }).blocked);
    setBusy(false);
  };
  const t = (es: string, en: string, pt: string) => tr({ es, en, pt }, lang);
  const diff = usd((v.approvedRefund ?? 0) - (v.reportedRefund ?? 0));
  const approved = usd(v.approvedRefund);
  const got = usd(v.reportedRefund);
  const mine = `****${v.intake?.refundAcctLast4 ?? "—"}`;
  const prep = v.preparer.name.split(" ")[0];
  const until = v.refundDeadline ? new Date(v.refundDeadline).toLocaleString(lang === "en" ? "en-US" : lang === "pt" ? "pt-BR" : "es-US", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
  const d = v.diversion;
  const diverted = d
    ? t(
        `El IRS emitió ${approved} (código 846, sin descuentos por deudas). La declaración presentada llevaba un Formulario 8888 que mandó ${usd(d.amount)} a la cuenta ****${d.acct}; la versión que usted aprobó lo enviaba todo a ${mine}.`,
        `The IRS issued ${approved} (code 846, no debt offsets). The filed return carried a Form 8888 that sent ${usd(d.amount)} to account ****${d.acct}; the version you approved sent it all to ${mine}.`,
        `O IRS emitiu ${approved} (código 846, sem descontos por dívidas). A declaração enviada tinha um Formulário 8888 que mandou ${usd(d.amount)} para a conta ****${d.acct}; a versão que você aprovou enviava tudo para ${mine}.`,
      )
    : "";
  const banner = (() => {
    switch (v.state) {
      case "AUTHORIZED":
        return <Banner tone="ok" title={t(`${usd(v.fee)} apartados, no cobrados`, `${usd(v.fee)} set aside, not charged`, `${usd(v.fee)} reservados, não cobrados`)}>{fill(tr(S.sign8879, lang), { prep: v.preparer.name })}</Banner>;
      case "TRANSMITTED":
        return <Banner tone="info" title={t(`${v.preparer.name} envió su declaración al IRS`, `${v.preparer.name} filed your return`, `${v.preparer.name} enviou sua declaração`)}>{t("Esperando la confirmación del IRS. Todavía no se ha cobrado nada.", "Waiting for the IRS confirmation. Nothing charged yet.", "Aguardando a confirmação do IRS. Nada foi cobrado ainda.")}</Banner>;
      case "CAPTURED":
        return <Banner tone="ok" title={t("El IRS recibió su declaración", "The IRS received your return", "O IRS recebeu sua declaração")}>{t(`${v.preparer.name} entregó la confirmación y recibió su pago. Cuando llegue su reembolso, díganos cuánto recibió.`, `${v.preparer.name} delivered the confirmation and was paid. When your refund arrives, tell us how much you got.`, `${v.preparer.name} entregou a confirmação e foi pago. Quando o reembolso chegar, diga quanto recebeu.`)}</Banner>;
      case "INVESTIGATING":
        return (
          <Banner tone="warn" title={t(`Su reembolso llegó con ${diff} menos de lo aprobado`, `Your refund arrived ${diff} short`, `Seu reembolso chegou com ${diff} a menos`)}>
            {t(
              `Usted aprobó ${approved} a su cuenta ${mine}; llegaron ${got}. El siguiente paso es el registro del IRS (transcript): muestra cuánto emitió el IRS, si se descontó alguna deuda y a qué cuentas fue el dinero.`,
              `You approved ${approved} to your account ${mine}; ${got} arrived. Next step: the IRS record (transcript). It shows how much the IRS issued, whether any debt was taken, and which accounts the money went to.`,
              `Você aprovou ${approved} para sua conta ${mine}; chegaram ${got}. Próximo passo: o registro do IRS (transcript). Ele mostra quanto o IRS emitiu, se alguma dívida foi descontada e para quais contas foi o dinheiro.`,
            )}
          </Banner>
        );
      case "UNRESOLVED":
        return <Banner tone="info" title={t("Revisión por una persona", "Under human review", "Revisão por uma pessoa")}>{t(`${v.preparer.name} presentó una explicación con evidencia. Una persona de SignClear revisará el caso en 5 días hábiles y le escribirá aquí. Mientras tanto, puede pedir ayuda al IRS con el formulario 14157-A.`, `${v.preparer.name} submitted an explanation with evidence. A person at SignClear will review the case within 5 business days and write to you here. Meanwhile you can ask the IRS for help with Form 14157-A.`, `${v.preparer.name} enviou uma explicação com evidências. Uma pessoa da SignClear revisará o caso em 5 dias úteis e escreverá aqui. Enquanto isso, você pode pedir ajuda ao IRS com o formulário 14157-A.`)}</Banner>;
      case "REFUND_PROPOSED": {
        const closed = v.refundWindowOpen === false || v.preparerVerdict === "NOT_REFUTED";
        if (closed)
          return (
            <Banner tone="warn" title={t(`Ya puede confirmar: le devolvemos ${usd(v.fee)}`, `You can confirm now: we refund your ${usd(v.fee)}`, `Já pode confirmar: devolvemos ${usd(v.fee)}`)}>
              {v.preparerVerdict === "INCONCLUSIVE"
                ? t(`Las 72 h de ${prep} terminaron y su respuesta no explica a dónde fue el dinero.`, `${prep}'s 72 h are over and his reply doesn't explain where the money went.`, `As 72 h de ${prep} terminaram e a resposta não explica para onde foi o dinheiro.`)
                : t(`${prep} no respondió en 72 h.`, `${prep} did not respond within 72 h.`, `${prep} não respondeu em 72 h.`)}{" "}
              {diverted} {t("Pulse «Confirmo» arriba y PayPal le devuelve la tarifa.", "Press “I confirm” above and PayPal refunds the fee.", "Pressione «Confirmo» acima e o PayPal devolve a taxa.")}
            </Banner>
          );
        if (v.preparerVerdict === "INCONCLUSIVE")
          return <Banner tone="warn" title={t(`${v.preparer.name} respondió`, `${v.preparer.name} replied`, `${v.preparer.name} respondeu`)}>{t(`Su respuesta no explica por qué el dinero no llegó a su cuenta. Cuando terminen las 72 h (${until}) podrá confirmar la devolución de la tarifa.`, `The reply doesn't explain why the money didn't reach your account. When the 72 h end (${until}) you can confirm the fee refund.`, `A resposta não explica por que o dinheiro não chegou. Ao fim das 72 h (${until}) você poderá confirmar a devolução da taxa.`)}</Banner>;
        return (
          <Banner tone="warn" title={t(`Propusimos devolverle la tarifa de ${usd(v.fee)}`, `We proposed refunding your ${usd(v.fee)} fee`, `Propusemos devolver sua taxa de ${usd(v.fee)}`)}>
            {diverted} {t(`${v.preparer.name} tiene hasta el ${until} (72 h) para responder con evidencia.`, `${v.preparer.name} has until ${until} (72 h) to respond with evidence.`, `${v.preparer.name} tem até ${until} (72 h) para responder com evidências.`)}
          </Banner>
        );
      }
      case "REFUNDED":
        return <Banner tone="ok" title={t(`Le devolvimos ${usd(v.fee)}`, `We refunded your ${usd(v.fee)}`, `Devolvemos ${usd(v.fee)}`)}>{v.diversion ? t(`Los ${usd(v.diversion.amount)} que fueron a ****${v.diversion.acct} se reclaman al IRS con el formulario 14157-A; le ayudamos a llenarlo. `, `To recover the ${usd(v.diversion.amount)} sent to ****${v.diversion.acct}, file IRS Form 14157-A; we'll help you fill it in. `, `Para recuperar os ${usd(v.diversion.amount)} enviados para ****${v.diversion.acct}, use o formulário 14157-A do IRS; ajudamos a preenchê-lo. `) : t("Para recuperar el resto del reembolso, le ayudamos con el formulario 14157-A del IRS. ", "To recover the rest of your refund, we'll help you with IRS Form 14157-A. ", "Para recuperar o restante, ajudamos com o formulário 14157-A do IRS. ")}{t("Ayuda gratuita: VITA o Taxpayer Advocate.", "Free help: VITA or Taxpayer Advocate.", "Ajuda gratuita: VITA ou Taxpayer Advocate.")}</Banner>;
      case "VOIDED":
        return <Banner tone="info" title={t("Cancelamos el apartado", "We cancelled the hold", "Cancelamos a reserva")}>{t("El dinero vuelve a estar disponible. Su banco puede tardar unos días.", "The money is available again. Your bank may take a few days.", "O dinheiro volta a ficar disponível. O banco pode levar alguns dias.")}</Banner>;
      case "CLOSED":
        return <Banner tone="ok" title={t("Todo coincide. Caso cerrado.", "Everything matches. Case closed.", "Tudo confere. Caso encerrado.")} />;
      default:
        return <Banner tone="info" title={t("Procesando…", "Processing…", "Processando…")} />;
    }
  })();
  const onlyClientMissing = v.state === "REFUND_PROPOSED" && v.guards.refund.length === 1 && v.guards.refund[0].includes("client");
  const action = (() => {
    if (v.state === "AUTHORIZED")
      return <button disabled={busy} onClick={() => run("cancel")} className="btn-secondary">{t("Cancelar y liberar mi pago", "Cancel and release my payment", "Cancelar e liberar meu pagamento")}</button>;
    if (v.state === "CAPTURED")
      return (
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-soft">{tr(S.howMuch, lang)}</span>
          <div className="flex items-center rounded-md border border-line bg-white px-3">
            <span className="text-ink-soft">$</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-24 bg-transparent py-2.5 pl-1 text-lg font-semibold tabular-nums outline-none" />
          </div>
          <button disabled={busy} onClick={() => run("report_refund", { amount: Number(amount) })} className="btn-primary">{t("Informar", "Report", "Informar")}</button>
        </div>
      );
    if (v.state === "INVESTIGATING" && !v.hasTranscript)
      return (
        <button disabled={busy} onClick={() => run("upload_transcript")} className="btn-primary">
          {t("Subir registro del IRS y depósito", "Upload IRS transcript and deposit", "Enviar registro do IRS e depósito")} <span className="badge-sim">{t("simulado", "simulated", "simulado")}</span>
        </button>
      );
    if (onlyClientMissing) return <button disabled={busy} onClick={() => run("confirm_refund")} className="btn-primary">{fill(t("Confirmo: devuélvanme {fee}", "I confirm: refund my {fee}", "Confirmo: devolvam {fee}"), { fee: usd(v.fee) })}</button>;
    if (v.state === "REFUNDED" || v.state === "UNRESOLVED")
      return <a className="btn-secondary" href="https://www.irs.gov/pub/irs-pdf/f14157a.pdf" target="_blank" rel="noreferrer">IRS Form 14157-A ↗</a>;
    return null;
  })();
  return (
    <div className="min-w-0 space-y-6">
      <Summary v={v} lang={lang} right={action} />
      {v.r15 && !v.sample && <Banner tone="info">{t("La cuenta de PayPal está a otro nombre. Si alguien pagó por usted, no pasa nada; lo dejamos anotado.", "The PayPal account is in another name. If someone paid for you, that's fine; we noted it.", "A conta PayPal está em outro nome. Se alguém pagou por você, tudo bem; anotamos.")}</Banner>}
      {err && <Banner tone="warn">{err}</Banner>}
      {refused && (
        <Banner tone="warn" title={t("Todavía no se puede", "Not possible yet", "Ainda não é possível")}>
          <Refusal conditions={refused} lang={lang} prep={v.preparer.name} client={v.clientName} />
        </Banner>
      )}
      <Workspace v={v} lang={lang} act={act} token={token}>
        {banner}
        <PayPalSteps v={v} lang={lang} />
      </Workspace>
    </div>
  );
}
