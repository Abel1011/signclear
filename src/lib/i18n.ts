import { brand } from "./brand";
export type Lang = "es" | "en" | "pt";
export type L10n = { es: string; en: string; pt: string };

export const t = (m: L10n | string, lang: Lang): string =>
  typeof m === "string" ? m : m[lang] ?? m.en;

export const fmtUSD = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

// UI strings for client screens (ES/EN/PT)
const RAW: Record<string, L10n> = {
  welcomeTitle: {
    es: "Entienda su declaración antes de aprobarla",
    en: "Understand your tax return before you approve it",
    pt: "Entenda sua declaração antes de aprová-la",
  },
  welcomeMoney: {
    es: "Usted le paga a {prep} {fee} por preparar su declaración. Firma Clara es gratis para usted. Tardará unos 5 minutos.",
    en: "You pay {prep} {fee} to prepare your return. Firma Clara is free for you. It takes about 5 minutes.",
    pt: "Você paga {prep} {fee} para preparar sua declaração. A Firma Clara é gratuita para você. Leva cerca de 5 minutos.",
  },
  ptinNote: {
    es: "{prep} dice estar registrado ante el IRS como preparador (PTIN). Lo comprobamos en su declaración.",
    en: "{prep} says they are registered with the IRS as a preparer (PTIN). We check it on your return.",
    pt: "{prep} diz estar registrado no IRS como preparador (PTIN). Verificamos isso na sua declaração.",
  },
  antiPhishing: {
    es: "Nunca le pedimos contraseñas ni que escriba su número de Seguro Social completo o su IP PIN.",
    en: "We never ask for passwords, or for you to type your full Social Security number or IP PIN.",
    pt: "Nunca pedimos senhas nem que você digite seu número completo do Seguro Social ou seu IP PIN.",
  },
  privacy: {
    es: "Clara, nuestra asistente de IA (Anthropic), lee sus documentos. No preguntamos su estatus migratorio. No compartimos sus datos con ninguna agencia, incluida inmigración, salvo obligación legal o que usted decida enviar un informe.",
    en: "Clara, our AI assistant (Anthropic), reads your documents. We don't ask about immigration status. We don't share your data with any agency, including immigration, unless legally required or you choose to send a report.",
    pt: "Clara, nossa assistente de IA (Anthropic), lê seus documentos. Não perguntamos sua situação migratória. Não compartilhamos seus dados com nenhuma agência, incluindo imigração, salvo obrigação legal ou se você decidir enviar um relatório.",
  },
  consentReview: {
    es: "Autorizo a {prep} y a Firma Clara a revisar mi declaración conmigo (obligatorio).",
    en: "I allow {prep} and Firma Clara to review my return with me (required).",
    pt: "Autorizo {prep} e a Firma Clara a revisar minha declaração comigo (obrigatório).",
  },
  consentOther: {
    es: "Permito otros usos para mejorar el servicio (opcional).",
    en: "I allow other uses to improve the service (optional).",
    pt: "Autorizo outros usos para melhorar o serviço (opcional).",
  },
  start: { es: "Entiendo y quiero seguir", en: "I understand, continue", pt: "Entendo e quero continuar" },
  matchTitle: {
    es: "Revisamos {n} puntos: {ok} coinciden{nc}{conf}. Todo lo que comprobamos coincide.",
    en: "We checked {n} items: {ok} match{nc}{conf}. Everything we checked matches.",
    pt: "Verificamos {n} pontos: {ok} conferem{nc}{conf}. Tudo o que verificamos confere.",
  },
  notAdvisor: {
    es: "La decisión es suya: no somos preparadores ni asesores fiscales.",
    en: "The decision is yours — we're not tax preparers or advisors.",
    pt: "A decisão é sua: não somos preparadores nem consultores fiscais.",
  },
  clarifyTitle: {
    es: "{agent} encontró {n} diferencia con lo que usted nos contó. Lea la explicación y confirme antes de aprobar.",
    en: "{agent} found {n} difference from what you told us. Read the explanation and confirm before approving.",
    pt: "{agent} encontrou {n} diferença com o que você nos contou. Leia a explicação e confirme antes de aprovar.",
  },
  diffTitle: {
    es: "Hay {n} puntos que conviene aclarar con {prep} antes de aprobar. Ya le preparamos las preguntas.",
    en: "There are {n} items to clear up with {prep} before approving. We drafted the questions for you.",
    pt: "Há {n} pontos para esclarecer com {prep} antes de aprovar. Já preparamos as perguntas.",
  },
  approve: {
    es: "Aprobar y apartar {fee} con PayPal",
    en: "Approve and hold {fee} with PayPal",
    pt: "Aprovar e reservar {fee} com PayPal",
  },
  approveNote: {
    es: "Puede ver un cargo pendiente en su banco: es normal. Se cobra cuando {prep} entregue la confirmación del IRS. Si no la entrega antes del {date}, cancelamos el apartado.",
    en: "You may see a pending charge at your bank: that's normal. It is charged when {prep} delivers the IRS confirmation. If not delivered by {date}, we cancel the hold.",
    pt: "Você pode ver uma cobrança pendente no banco: é normal. É cobrado quando {prep} entregar a confirmação do IRS. Se não entregar até {date}, cancelamos a reserva.",
  },
  sign8879: {
    es: "Ahora firme la hoja de autorización (8879) con {prep}. Fírmela solo si los números coinciden con esta tabla.",
    en: "Now sign the authorization form (8879) with {prep}. Sign it only if the numbers match this table.",
    pt: "Agora assine o formulário de autorização (8879) com {prep}. Assine somente se os números conferirem com esta tabela.",
  },
  howMuch: {
    es: "¿Cuánto le llegó de su reembolso federal?",
    en: "How much of your federal refund arrived?",
    pt: "Quanto do seu reembolso federal chegou?",
  },
  askClara: { es: "Preguntar a Clara", en: "Ask Clara", pt: "Perguntar à Clara" },
  inDoc: { es: "Ver en el documento", en: "View in document", pt: "Ver no documento" },
  onlyReview: { es: "Solo lo que hay que revisar", en: "Only what needs review", pt: "Só o que precisa revisar" },
  all: { es: "Todo", en: "All", pt: "Tudo" },
  allSources: { es: "Ver todas las fuentes", en: "Show all sources", pt: "Ver todas as fontes" },
};

export const S: Record<string, L10n> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, { es: brand(v.es), en: brand(v.en), pt: brand(v.pt) }]),
);

/** Prevention moment (refund routed to an account that is not the client's) + voice controls. */
export const FRAUD_COPY: Record<string, L10n> = {
  title: { es: "Este dinero no iría a usted", en: "This money would not go to you", pt: "Este dinheiro não iria para você" },
  body: {
    es: "Su declaración manda su reembolso de {refund} a la cuenta ****{bad}. Usted nos dio la cuenta ****{mine}. Si firma así, el IRS depositaría su dinero en una cuenta que no es suya, y es muy difícil recuperarlo.",
    en: "Your return sends your {refund} refund to account ****{bad}. You gave us account ****{mine}. If you sign it like this, the IRS would deposit your money into an account that isn't yours — and it is very hard to get back.",
    pt: "Sua declaração manda seu reembolso de {refund} para a conta ****{bad}. Você nos deu a conta ****{mine}. Se assinar assim, o IRS depositaria seu dinheiro numa conta que não é sua, e é muito difícil recuperá-lo.",
  },
  held: {
    es: "No se puede aprobar. PayPal no apartó nada: {prep} no cobra por esta declaración.",
    en: "It can't be approved. PayPal held nothing: {prep} is not paid for this return.",
    pt: "Não pode ser aprovada. O PayPal não reservou nada: {prep} não recebe por esta declaração.",
  },
  stamp: { es: "No aprobada", en: "Not approved", pt: "Não aprovada" },
  next: { es: "Qué hacer ahora", en: "What to do now", pt: "O que fazer agora" },
  step1: { es: "No firme el formulario 8879 ni dé su PIN de firma.", en: "Don't sign Form 8879 or give your signature PIN.", pt: "Não assine o formulário 8879 nem dê seu PIN de assinatura." },
  step2: {
    es: "Pida a {prep} que ponga su cuenta ****{mine} y suba la declaración corregida. {agent} la revisará otra vez.",
    en: "Ask {prep} to put your account ****{mine} and upload the corrected return. {agent} will check it again.",
    pt: "Peça a {prep} que coloque sua conta ****{mine} e envie a declaração corrigida. {agent} vai revisá-la de novo.",
  },
  step3: {
    es: "Si se niega, denúncielo al IRS con el formulario 14157 (gratis). Ayuda gratuita: VITA o Taxpayer Advocate.",
    en: "If they refuse, report them to the IRS with Form 14157 (free). Free help: VITA or Taxpayer Advocate.",
    pt: "Se recusar, denuncie ao IRS com o formulário 14157 (grátis). Ajuda gratuita: VITA ou Taxpayer Advocate.",
  },
  askFix: { es: "Pedir a {prep} que lo corrija", en: "Ask {prep} to fix it", pt: "Pedir a {prep} que corrija" },
  askFixText: {
    es: "Mi reembolso iría a la cuenta ****{bad}, que no es mía. Ayúdeme a pedirle a {prep} que ponga mi cuenta ****{mine}.",
    en: "My refund would go to account ****{bad}, which isn't mine. Help me ask {prep} to use my account ****{mine}.",
    pt: "Meu reembolso iria para a conta ****{bad}, que não é minha. Me ajude a pedir a {prep} que coloque minha conta ****{mine}.",
  },
  report: { es: "Denunciar al IRS (formulario 14157)", en: "Report to the IRS (Form 14157)", pt: "Denunciar ao IRS (formulário 14157)" },
  notYours: { es: "no es su cuenta", en: "not your account", pt: "não é sua conta" },
  before: { es: "Antes de firmar", en: "Before you sign", pt: "Antes de assinar" },
  returnSends: { es: "Su declaración manda el dinero a", en: "Your return sends the money to", pt: "Sua declaração manda o dinheiro para" },
  yourAcct: { es: "Su cuenta", en: "Your account", pt: "Sua conta" },
  heldNothing: { es: "PayPal no apartó nada", en: "PayPal held nothing", pt: "O PayPal não reservou nada" },
  asked: { es: "Pedido enviado a {agent}: le redactará el mensaje para {prep}.", en: "Sent to {agent}: she'll draft the message for {prep}.", pt: "Enviado para {agent}: ela vai escrever a mensagem para {prep}." },
};

export const VOICE_COPY: Record<string, L10n> = {
  listen: { es: "Escuchar", en: "Listen", pt: "Ouvir" },
  stop: { es: "Detener", en: "Stop", pt: "Parar" },
  speak: { es: "Hablar", en: "Speak", pt: "Falar" },
  listening: { es: "Escuchando…", en: "Listening…", pt: "Ouvindo…" },
  summary: {
    es: "Su reembolso federal es de {refund} y va a la cuenta {acct}. Lo preparó {prep}. La tarifa del preparador es {fee}.",
    en: "Your federal refund is {refund} and goes to account {acct}. It was prepared by {prep}. The preparer's fee is {fee}.",
    pt: "Seu reembolso federal é de {refund} e vai para a conta {acct}. Foi preparado por {prep}. A taxa do preparador é {fee}.",
  },
};

export const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

/** A payment guardian's refusal condition, in plain words for clients and preparers, with the rule id kept
 *  apart as a small tag. Unknown conditions fall back to the raw text (never hidden). */
export function plainCondition(raw: string, ctx: { prep: string; client: string }): { text: L10n; tag: string | null } {
  const p = ctx.prep.split(" ")[0] || ctx.prep;
  const c = ctx.client.split(" ")[0] || ctx.client;
  const tag = /^(R\d+[a-z]?|Radar)\b/.exec(raw)?.[1] ?? null;
  const T = (es: string, en: string, pt: string) => ({ text: { es, en, pt }, tag });
  const st = /state is (\w+)/.exec(raw)?.[1];
  if (/no IRS confirmation|not accepted in state|upload the IRS e-file acknowledgment/i.test(raw))
    return T(`A ${p} todavía no se le puede pagar: el IRS no ha confirmado que recibió la declaración.`, `${p} can't be paid yet: the IRS hasn't confirmed it received the return.`, `${p} ainda não pode receber: o IRS não confirmou que recebeu a declaração.`);
  if (/no state acceptance/i.test(raw)) return T("El estado todavía no confirmó que recibió la declaración estatal.", "The state hasn't confirmed it received the state return yet.", "O estado ainda não confirmou o recebimento da declaração estadual.");
  if (/Submission ID does not start/i.test(raw)) return T(`El envío al IRS no salió de la cuenta de e-file (EFIN) de ${p}.`, `The IRS submission didn't come from ${p}'s e-file account (EFIN).`, `O envio ao IRS não saiu da conta de e-file (EFIN) de ${p}.`);
  if (/no (state )?Submission ID/i.test(raw)) return T("Todavía no se registró el envío al IRS.", "No IRS e-file submission has been recorded yet.", "Ainda não foi registrado o envio ao IRS.");
  if (/after deadline/i.test(raw)) return T("La confirmación del IRS llegó después del plazo.", "The IRS confirmation came after the deadline.", "A confirmação do IRS chegou depois do prazo.");
  if (/federal fee not collected/i.test(raw)) return T("Primero se cobra la parte federal, cuando el IRS acepta.", "The federal part is collected first, when the IRS accepts.", "Primeiro se cobra a parte federal, quando o IRS aceita.");
  if (/^no authorization/i.test(raw)) return T("No hay un pago apartado en PayPal para este caso.", "There's no PayPal hold on this case.", "Não há pagamento reservado no PayPal neste caso.");
  if (/authorization expired/i.test(raw)) return T("El apartado de PayPal venció.", "The PayPal hold expired.", "A reserva do PayPal venceu.");
  if (/^Radar/i.test(raw)) return T(`Los cobros de ${p} están en revisión por el radar de riesgo.`, `${p}'s payments are on hold for a risk review.`, `Os recebimentos de ${p} estão em revisão de risco.`);
  if (/client cannot cancel after transmission/i.test(raw)) return T("La declaración ya se envió al IRS: el apartado ya no se puede cancelar.", "The return was already filed with the IRS: the hold can no longer be cancelled.", "A declaração já foi enviada ao IRS: a reserva não pode mais ser cancelada.");
  if (/72 h response window still open/i.test(raw)) return T(`${p} todavía está dentro de sus 72 h para responder.`, `${p} still has time to respond (72 h window).`, `${p} ainda está dentro das 72 h para responder.`);
  if (/client has not confirmed/i.test(raw)) return T(`${c} todavía no confirmó la devolución.`, `${c} hasn't confirmed the refund yet.`, `${c} ainda não confirmou a devolução.`);
  if (/evidence refuted/i.test(raw)) return T(`La evidencia de ${p} explica la diferencia; una persona revisa el caso.`, `${p}'s evidence explains the difference; a person reviews the case.`, `A evidência de ${p} explica a diferença; uma pessoa revisa o caso.`);
  if (/no capture to refund/i.test(raw)) return T("No hay un cobro que devolver.", "There's no collected payment to refund.", "Não há cobrança para devolver.");
  if (/150-day/i.test(raw)) return T("Pasaron más de 150 días desde el cobro: PayPal ya no permite devolverlo.", "More than 150 days passed since the payment: PayPal no longer allows a refund.", "Passaram mais de 150 dias do pagamento: o PayPal não permite mais devolver.");
  if (/no refund proposal open/i.test(raw)) return T("No hay una propuesta de devolución abierta.", "There's no open refund proposal.", "Não há proposta de devolução aberta.");
  if (st) {
    if (["CAPTURED", "CLOSED", "INVESTIGATING", "REFUND_PROPOSED", "UNRESOLVED"].includes(st)) return T(`${p} ya cobró esta tarifa.`, `${p} was already paid for this return.`, `${p} já recebeu por esta declaração.`);
    if (st === "AUTHORIZED") return T("La declaración todavía no se envió al IRS.", "The return hasn't been filed with the IRS yet.", "A declaração ainda não foi enviada ao IRS.");
    if (["VOIDED", "REFUNDED"].includes(st)) return T("Este caso ya está cerrado.", "This case is already closed.", "Este caso já está encerrado.");
    return T(`No es posible en este paso del caso (${st}).`, `Not possible at this step of the case (${st}).`, `Não é possível nesta etapa do caso (${st}).`);
  }
  return { text: { es: raw, en: raw, pt: raw }, tag };
}

