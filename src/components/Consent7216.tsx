"use client";
import { useState } from "react";
import type { Lang } from "./useCase";
import { APP_NAME, AGENT_NAME } from "@/lib/brand";

type L = Record<Lang, string>;
const T = (l: L, lang: Lang) => l[lang] ?? l.en;

/**
 * IRC §7216 consent, on its own screen (Rev. Proc. 2013-14 §5.03), with the mandatory statements of §5.04.
 * Voluntary: declining does not stop the preparer from preparing and filing the return.
 */
export function Consent7216({
  lang,
  client,
  preparer,
  business,
  onBack,
  onSign,
}: {
  lang: Lang;
  client: string;
  preparer: string;
  business: string;
  onBack: () => void;
  onSign: (c: { signedName: string; signedAt: string; version: string; expires: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = new Date();
  const expires = new Date(today.getTime() + 365 * 86400_000);
  const fmt = (d: Date) => d.toLocaleDateString(lang === "en" ? "en-US" : lang === "pt" ? "pt-BR" : "es-US", { day: "numeric", month: "long", year: "numeric" });
  const who = { client, preparer, business, app: APP_NAME, agent: AGENT_NAME, until: fmt(expires) };
  const f = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => (who as Record<string, string>)[k] ?? "");

  const body: { h: L; p: L }[] = [
    {
      h: { es: "Qué autoriza", en: "What you authorize", pt: "O que você autoriza" },
      p: {
        es: "Yo, {client}, autorizo a {preparer} ({business}) a divulgar a {app} la información de mi declaración de impuestos federal 2025: el borrador de la declaración, el formulario 8879 sin firmar y mis respuestas a la entrevista.",
        en: "I, {client}, authorize {preparer} ({business}) to disclose to {app} the information in my 2025 federal tax return: the draft return, the unsigned Form 8879 and my interview answers.",
        pt: "Eu, {client}, autorizo {preparer} ({business}) a divulgar à {app} as informações da minha declaração de imposto federal 2025: o rascunho, o formulário 8879 não assinado e minhas respostas à entrevista.",
      },
    },
    {
      h: { es: "Para qué", en: "For what purpose", pt: "Para quê" },
      p: {
        es: "Solo para (1) comparar la declaración con lo que yo conté y explicármela en mi idioma, y (2) apartar y liberar la tarifa del preparador con PayPal según la confirmación del IRS. No para publicidad ni para vender mis datos.",
        en: "Only to (1) compare the return with what I told them and explain it to me in my language, and (2) hold and release the preparer's fee with PayPal based on the IRS confirmation. Not for marketing, and my data is never sold.",
        pt: "Somente para (1) comparar a declaração com o que eu contei e explicá-la no meu idioma, e (2) reservar e liberar a taxa do preparador com o PayPal conforme a confirmação do IRS. Não para publicidade nem venda de dados.",
      },
    },
    {
      h: { es: "Quién la recibe", en: "Who receives it", pt: "Quem recebe" },
      p: {
        es: "{app}; Anthropic, que procesa los documentos con IA ({agent}) por encargo de {app} y no los usa para entrenar modelos; y PayPal, que solo recibe el importe de la tarifa y los datos del pago.",
        en: "{app}; Anthropic, which processes the documents with AI ({agent}) on behalf of {app} and does not use them to train models; and PayPal, which only receives the fee amount and payment details.",
        pt: "{app}; a Anthropic, que processa os documentos com IA ({agent}) em nome da {app} e não os usa para treinar modelos; e o PayPal, que recebe apenas o valor da taxa e os dados do pagamento.",
      },
    },
    {
      h: { es: "Duración", en: "Duration", pt: "Duração" },
      p: {
        es: "Este consentimiento vale hasta el {until}. Puede retirarlo en cualquier momento.",
        en: "This consent is valid until {until}. You may withdraw it at any time.",
        pt: "Este consentimento vale até {until}. Você pode retirá-lo a qualquer momento.",
      },
    },
  ];
  const required: L = {
    es: "La ley federal exige que se le entregue este formulario de consentimiento. Salvo que la ley lo autorice, no podemos divulgar la información de su declaración a terceros para fines distintos de la preparación y presentación de su declaración sin su consentimiento. No está obligado a completar este formulario: si no lo firma, {preparer} igual puede preparar y presentar su declaración; solo no tendrá la revisión en {app}. Si obtuviéramos su firma condicionando nuestros servicios a su consentimiento, el consentimiento no sería válido. Si usted cree que la información de su declaración fue divulgada o usada de forma indebida, sin autorización legal o sin su permiso, puede contactar al Inspector General del Tesoro para la Administración Tributaria (TIGTA) por teléfono al 1-800-366-4484 o por correo a complaints@tigta.treas.gov.",
    en: "Federal law requires this consent form be provided to you. Unless authorized by law, we cannot disclose your tax return information to third parties for purposes other than the preparation and filing of your tax return without your consent. You are not required to complete this form: if you don't sign it, {preparer} can still prepare and file your return; you just won't get the review in {app}. If we obtain your signature on this form by conditioning our services on your consent, your consent will not be valid. If you believe your tax return information has been disclosed or used improperly in a manner unauthorized by law or without your permission, you may contact the Treasury Inspector General for Tax Administration (TIGTA) by telephone at 1-800-366-4484, or by email at complaints@tigta.treas.gov.",
    pt: "A lei federal exige que este formulário de consentimento lhe seja entregue. Salvo autorização legal, não podemos divulgar as informações da sua declaração a terceiros para fins diferentes da preparação e entrega da declaração sem o seu consentimento. Você não é obrigado a preencher este formulário: se não assinar, {preparer} ainda pode preparar e entregar sua declaração; você só não terá a revisão na {app}. Se obtivermos sua assinatura condicionando nossos serviços ao consentimento, ele não será válido. Se você acredita que suas informações foram divulgadas ou usadas indevidamente, sem autorização legal ou sem sua permissão, pode contatar o Inspetor-Geral do Tesouro para a Administração Tributária (TIGTA) pelo telefone 1-800-366-4484 ou pelo e-mail complaints@tigta.treas.gov.",
  };
  const fullText = [f(T({ es: "Consentimiento para divulgar la información de su declaración", en: "Consent to disclose tax return information", pt: "Consentimento para divulgar informações da declaração" }, lang)), ...body.map((b) => `${T(b.h, lang)}: ${f(T(b.p, lang))}`), f(T(required, lang))].join("\n\n");
  const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const signedOk = norm(name) === norm(client);
  const download = () => {
    const txt = `${fullText}\n\n${T({ es: "Firmado", en: "Signed", pt: "Assinado" }, lang)}: ${name} · ${fmt(today)}`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain;charset=utf-8" }));
    a.download = `consent-7216-${client.replace(/\s+/g, "-")}.txt`;
    a.click();
  };
  return (
    <div className="card mx-auto max-w-3xl p-6 sm:p-9">
      <div className="eyebrow">IRC §7216 · {T({ es: "paso 2 de 2", en: "step 2 of 2", pt: "passo 2 de 2" }, lang)}</div>
      <h1 className="mt-2 font-display text-3xl sm:text-4xl">{T({ es: "Consentimiento para divulgar la información de su declaración", en: "Consent to disclose your tax return information", pt: "Consentimento para divulgar as informações da sua declaração" }, lang)}</h1>
      <div className="mt-6 space-y-4 text-[15px] leading-relaxed">
        {body.map((b) => (
          <div key={b.h.en}>
            <div className="font-semibold">{T(b.h, lang)}</div>
            <div className="text-ink">{f(T(b.p, lang))}</div>
          </div>
        ))}
        <div className="rounded-md border-[1.5px] border-dashed border-ink/40 bg-paper p-4 text-sm text-ink">{f(T(required, lang))}</div>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <label>
          <span className="block font-mono text-xs font-semibold uppercase tracking-wider text-ink-soft">{T({ es: "Firme escribiendo su nombre completo", en: "Sign by typing your full name", pt: "Assine digitando seu nome completo" }, lang)}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={client} className="mt-1 w-full rounded-md border-[1.5px] border-ink/30 bg-white px-3 py-2.5 font-display text-xl italic outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-mark" />
        </label>
        <div className="font-mono text-sm text-ink-soft">{fmt(today)}</div>
      </div>
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-5 w-5 accent-ink" />
        <span>{T({ es: "Leí este consentimiento y lo firmo voluntariamente.", en: "I have read this consent and sign it voluntarily.", pt: "Li este consentimento e o assino voluntariamente." }, lang)}</span>
      </label>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          disabled={!agree || !signedOk || busy}
          onClick={async () => {
            setBusy(true);
            await onSign({ signedName: name.trim(), signedAt: today.toISOString(), version: "7216-v1", expires: expires.toISOString() });
            setBusy(false);
          }}
          className="btn-primary px-6 py-3"
        >
          {T({ es: "Firmar y continuar", en: "Sign and continue", pt: "Assinar e continuar" }, lang)} →
        </button>
        <button onClick={onBack} className="btn-secondary">
          ← {T({ es: "Volver a la entrevista", en: "Back to the interview", pt: "Voltar à entrevista" }, lang)}
        </button>
        <button onClick={download} className="text-sm font-semibold underline underline-offset-2">
          {T({ es: "Descargar una copia", en: "Download a copy", pt: "Baixar uma cópia" }, lang)}
        </button>
      </div>
      {name && !signedOk && <div className="mt-2 text-xs text-ink-soft">{T({ es: "Escriba su nombre tal como aparece arriba:", en: "Type your name as shown above:", pt: "Digite seu nome como aparece acima:" }, lang)} {client}</div>}
      <div className="mt-6 border-t border-dashed border-ink/30 pt-4 text-sm text-ink-soft">
        {T({ es: "¿Prefiere no firmar? No pasa nada: avise a", en: "Prefer not to sign? That's fine — tell", pt: "Prefere não assinar? Tudo bem — avise" }, lang)} {preparer} {T({ es: "y su declaración se presentará igual, sin esta revisión.", en: "and your return will still be filed, just without this review.", pt: "e sua declaração será entregue do mesmo jeito, sem esta revisão." }, lang)}
      </div>
    </div>
  );
}
