// Guardians: the ONLY entry points that move money. Both the agent's tools and the
// deterministic state machine call these functions. Pattern: check -> claim -> call -> record.
import { db } from "./db";
import { paypal, authFromOrder, multipartyEnabled, type Link } from "./paypal";
import { toValues } from "./reader";
import { audit, notify } from "./audit";
import { now, ackDeadline } from "./clock";
import { fmtUSD } from "./i18n";
import { APP_NAME } from "./brand";
import type { Case, Payment, Preparer, FeeLine } from "@prisma/client";

type FullCase = Case & { payment: Payment | null; preparer: Preparer };

export type GuardResult = { ok: boolean; blocked?: string[]; detail?: unknown; already?: boolean };

const STALE_MS = 2 * 60_000;
/** SignClear's platform fee per return, taken on the federal capture when the preparer is the merchant (multiparty). */
export const platformFeeCents = () => Math.max(0, Number(process.env.PLATFORM_FEE_CENTS ?? 400) || 0);
const transient = (status: number) => status >= 500 || status === 401 || status === 429;

async function load(caseId: string): Promise<FullCase> {
  return db.case.findUniqueOrThrow({ where: { id: caseId }, include: { payment: true, preparer: true } });
}

/** Atomic claim: move from expected state to a *_PENDING state, bumping version. */
async function claim(c: Case, from: string[], to: string): Promise<boolean> {
  const r = await db.case.updateMany({
    where: { id: c.id, version: c.version, state: { in: from } },
    data: { state: to, version: { increment: 1 } },
  });
  return r.count === 1;
}

/** Conditional write: only moves the case if it is still in `from` (prevents last-writer-wins races). */
async function setState(caseId: string, from: string, to: string, extra: Record<string, unknown> = {}) {
  const r = await db.case.updateMany({ where: { id: caseId, state: from }, data: { state: to, version: { increment: 1 }, ...extra } });
  return r.count === 1;
}

/** Conditional line write (same idea, per fee line). */
async function setLine(lineId: string, from: string[], data: Partial<FeeLine>) {
  const r = await db.feeLine.updateMany({ where: { id: lineId, status: { in: from } }, data });
  return r.count === 1;
}

// ------------------------------------------------------------------ fee lines
/** Federal / state split of the case fee. stateFee = 0 keeps the historical single-fee behaviour. */
export function feeSplit(c: Pick<Case, "fee" | "stateFee">) {
  const state = Math.max(0, Math.min(c.stateFee ?? 0, c.fee - 1));
  return state > 0
    ? [
        { kind: "FEDERAL" as const, amountCents: c.fee - state, name: "Federal return preparation" },
        { kind: "STATE" as const, amountCents: state, name: "State return preparation" },
      ]
    : [{ kind: "FEDERAL" as const, amountCents: c.fee, name: "Tax return preparation" }];
}

/** Lines for a case; created lazily for cases authorized before fee lines existed (backwards compatible). */
export async function getLines(caseId: string): Promise<FeeLine[]> {
  const existing = await db.feeLine.findMany({ where: { caseId }, orderBy: { kind: "asc" } });
  if (existing.length) return existing;
  const c = await db.case.findUnique({ where: { id: caseId }, include: { payment: true } });
  if (!c?.payment?.authorizationId) return [];
  for (const l of feeSplit(c)) {
    const captured = l.kind === "FEDERAL" && c.payment.captureId;
    await db.feeLine.upsert({
      where: { caseId_kind: { caseId, kind: l.kind } },
      create: {
        caseId,
        kind: l.kind,
        amount: l.amountCents,
        status: captured ? (c.payment.refundId ? "REFUNDED" : "COMPLETED") : "AUTHORIZED",
        captureId: captured ? c.payment.captureId : null,
        capturedAt: captured ? c.capturedAt : null,
        refundId: l.kind === "FEDERAL" ? c.payment.refundId : null,
      },
      update: {},
    });
  }
  return db.feeLine.findMany({ where: { caseId }, orderBy: { kind: "asc" } });
}

/** Preparer sets how much of the fee is for the state return. Only before the client approves. */
export async function setStateFee(caseId: string, stateCents: number): Promise<GuardResult> {
  const c = await load(caseId);
  if (!Number.isInteger(stateCents) || stateCents < 0 || stateCents >= c.fee) return { ok: false, blocked: ["state fee must be between $0 and the total fee"] };
  if (c.payment?.authorizationId || !["CASE_CREATED", "CONSENTED", "PROCESSING", "CLARIFY", "DIFFERENCES", "MATCH"].includes(c.state))
    return { ok: false, blocked: [`fee split is locked in state ${c.state}`] };
  const r = await db.case.updateMany({ where: { id: caseId, version: c.version }, data: { stateFee: stateCents, version: { increment: 1 } } });
  if (r.count !== 1) return { ok: false, blocked: ["concurrent update"] };
  await audit(caseId, "user", "fee_split_set", { detail: { federal: c.fee - stateCents, state: stateCents } });
  return { ok: true };
}

// ---------------------------------------------------------------- create_order
export async function createOrder(caseId: string, opts: { card?: boolean; vaultId?: string } = {}) {
  const c = await load(caseId);
  if (c.state !== "MATCH") return { ok: false, blocked: [`state is ${c.state}, must be MATCH`] };
  const attempt = (c.payment?.attempt ?? 0) + (c.payment?.orderId ? 1 : 0) || 1;
  const invoiceId = `FC-${c.id}-${attempt}`;
  const lines = feeSplit(c);
  // Multiparty: the preparer is the merchant of record (only when onboarded and MULTIPARTY=1).
  const payee = multipartyEnabled() && c.preparer.paypalMerchantId ? c.preparer.paypalMerchantId : null;
  const res = await paypal.createAuthorizeOrder({
    amountCents: c.fee,
    invoiceId,
    customId: c.id,
    description: `Tax preparation fee — ${c.preparer.business}`,
    requestId: `ord-${c.id}-${attempt}${opts.vaultId ? "-seat" : ""}`,
    items: lines.length > 1 ? lines : undefined,
    payeeMerchantId: payee,
    vaultId: opts.vaultId,
    card: opts.card
      ? { number: process.env.PAYPAL_TEST_CARD || "4032039317984658", expiry: process.env.PAYPAL_TEST_CARD_EXP || "2030-01", name: c.clientName }
      : undefined,
  });
  await audit(caseId, "paypal", "create_order", { detail: { status: res.status, endpoint: res.endpoint, lines: lines.length, multiparty: !!payee, vault: !!opts.vaultId }, debugId: res.debugId ?? undefined });
  if (!res.ok || !res.body) return { ok: false, blocked: [`PayPal error ${res.status}`], detail: res.body };
  const orderId = (res.body as { id: string }).id;
  await db.payment.upsert({
    where: { caseId },
    create: { caseId, orderId, amount: c.fee, attempt, status: "CREATED", lastDebugId: res.debugId, payeeMerchantId: payee },
    update: { orderId, attempt, status: "CREATED", lastDebugId: res.debugId, payeeMerchantId: payee },
  });
  // Server-side (card / vaulted wallet) orders may already come back authorized
  const auth = authFromOrder(res.body);
  if (auth) await recordAuthorization(caseId, auth, res.debugId);
  return { ok: true, orderId, authorized: !!auth, orderStatus: (res.body as { status?: string }).status };
}

// ------------------------------------------------------------------- authorize
export async function authorizeOrder(caseId: string, orderId: string) {
  const c = await load(caseId);
  if (c.payment?.orderId !== orderId) return { ok: false, blocked: ["order does not belong to this case"] };
  if (c.state === "AUTHORIZED") return { ok: true, already: true };
  if (c.state !== "MATCH") return { ok: false, blocked: [`state is ${c.state}, must be MATCH`] };
  const res = await paypal.authorizeOrder(orderId, `auth-${orderId}`);
  await audit(caseId, "paypal", "authorize", { detail: { status: res.status }, debugId: res.debugId ?? undefined });
  const auth = res.ok ? authFromOrder(res.body) : null;
  if (!auth) {
    const issue = (res.body as { details?: Array<{ issue?: string }> })?.details?.[0]?.issue;
    await audit(caseId, "paypal", "authorize_failed", { detail: { issue } });
    return { ok: false, blocked: [issue ?? `PayPal error ${res.status}`], issue };
  }
  if (auth.status !== "CREATED") {
    await audit(caseId, "paypal", "authorize_failed", { detail: { status: auth.status } });
    return { ok: false, blocked: [`authorization status ${auth.status}`] };
  }
  await recordAuthorization(caseId, auth, res.debugId);
  return { ok: true };
}

/**
 * Judge seats: authorize the case fee server-side with a vaulted PayPal wallet (Vault v3 payment token
 * PAYPAL_SEAT_VAULT_ID, created once with scripts/paypal/vault-setup.mts). Same guardians as the button flow.
 */
export async function seatAuthorize(caseId: string): Promise<GuardResult & { orderId?: string }> {
  const vaultId = process.env.PAYPAL_SEAT_VAULT_ID;
  if (!vaultId) return { ok: false, blocked: ["PAYPAL_SEAT_VAULT_ID is not configured"] };
  const c = await load(caseId);
  if (c.state === "AUTHORIZED") return { ok: true, already: true };
  if (!c.isDemo) return { ok: false, blocked: ["judge seats are for demo cases only"] };
  const r = await createOrder(caseId, { vaultId });
  if (!r.ok || !("orderId" in r) || !r.orderId) return { ok: false, blocked: r.blocked ?? ["could not create order"], detail: r.detail };
  if (r.authorized) {
    await audit(caseId, "paypal", "seat_authorized", { detail: { orderId: r.orderId, vault: "PAYPAL_SEAT_VAULT_ID" } });
    return { ok: true, orderId: r.orderId };
  }
  // Some vaulted orders come back APPROVED: authorize explicitly.
  const a = await authorizeOrder(caseId, r.orderId);
  if (a.ok) await audit(caseId, "paypal", "seat_authorized", { detail: { orderId: r.orderId, vault: "PAYPAL_SEAT_VAULT_ID" } });
  return { ...a, orderId: r.orderId };
}

async function recordAuthorization(
  caseId: string,
  auth: { id: string; status: string; expiration?: string; payerName: string | null },
  debugId: string | null,
) {
  const c = await load(caseId);
  const t = now(c);
  const deadline = ackDeadline(t, c.seasonOpen, t);
  const r15 = !!auth.payerName && auth.payerName.trim().toLowerCase() !== c.clientName.trim().toLowerCase();
  // Snapshot of what the client approved is written atomically with the authorization.
  const draft = toValues(await db.extractedValue.findMany({ where: { caseId, docKind: "DRAFT_1040" } }));
  const claimed = await db.case.updateMany({
    where: { id: caseId, state: "MATCH" },
    data: { state: "AUTHORIZED", version: { increment: 1 }, approvedAt: t, ackDeadline: deadline, r15Flag: r15 },
  });
  if (claimed.count !== 1) return; // already recorded (double onApprove / webhook) — idempotent
  await db.approvedSnapshot.upsert({ where: { caseId }, create: { caseId, data: JSON.stringify(draft) }, update: { data: JSON.stringify(draft) } });
  await db.payment.update({
    where: { caseId },
    data: {
      authorizationId: auth.id,
      status: "AUTHORIZED",
      payerName: auth.payerName,
      expirationTime: auth.expiration ? new Date(auth.expiration) : new Date(t.getTime() + 29 * 86400_000),
      lastDebugId: debugId,
    },
  });
  for (const l of feeSplit(c))
    await db.feeLine.upsert({
      where: { caseId_kind: { caseId, kind: l.kind } },
      create: { caseId, kind: l.kind, amount: l.amountCents },
      update: { amount: l.amountCents, status: "AUTHORIZED", captureId: null, capturedAt: null, refundId: null, refundedAmount: 0 },
    });
  await audit(caseId, "paypal", "authorization_recorded", {
    from: "MATCH",
    to: "AUTHORIZED",
    debugId: debugId ?? undefined,
    detail: { authorizationId: auth.id, payerName: auth.payerName, r15, lines: feeSplit(c).map((l) => `${l.kind}:${l.amountCents}`) },
  });
  await notify(caseId, "preparer", {
    es: `${c.clientName} aprobó su declaración: ${fmtUSD(c.fee)} apartados.`,
    en: `${c.clientName} approved the return: ${fmtUSD(c.fee)} set aside.`,
    pt: `${c.clientName} aprovou a declaração: ${fmtUSD(c.fee)} reservados.`,
  });
}

// --------------------------------------------------------------------- capture
export function captureConditions(c: FullCase): string[] {
  const fails: string[] = [];
  if (c.state !== "TRANSMITTED") fails.push(`state is ${c.state}, must be TRANSMITTED`);
  if (!c.ackReceivedAt) fails.push("R13: no IRS confirmation (\"Accepted\") on file");
  if (c.submissionId && !c.submissionId.startsWith(c.preparer.efin))
    fails.push("R13: Submission ID does not start with the preparer's EFIN");
  if (!c.submissionId) fails.push("R13: no Submission ID registered");
  if (c.ackDeadline && c.ackReceivedAt && c.ackReceivedAt > c.ackDeadline) fails.push("R13: IRS confirmation after deadline");
  if (!c.payment?.authorizationId) fails.push("no authorization");
  if (c.payment?.expirationTime && now(c) > c.payment.expirationTime) fails.push("authorization expired");
  return fails;
}

export async function capture(caseId: string, actor: "ai" | "system", rationale?: string): Promise<GuardResult> {
  const c = await load(caseId);
  if (c.state === "CAPTURED" || c.payment?.captureId) return { ok: true, already: true };
  const fails = captureConditions(c);
  // Ghost-preparer radar: a preparer whose clients show a fraud pattern doesn't get paid until reviewed.
  try {
    const { radarFlagsForPreparer, radarPopulationFromDb } = await import("./radar");
    // Arena runs share one simulated world (and the same sample preparer): radar is evaluated on real desks only.
    const r = c.paypalSim ? { hold: false, score: 0, reasons: [] as string[] } : radarFlagsForPreparer(c.preparer.ptin, await radarPopulationFromDb(c.isDemo ? c.demoSession : null));
    if (r.hold) fails.push(`Radar: preparer held for review (risk ${r.score}) — ${r.reasons[0] ?? ""}`);
  } catch (e) {
    console.error("radar", e);
  }
  if (fails.length) {
    await audit(caseId, "guardian", "capture_blocked", { rationale, detail: { by: actor, conditions: fails } });
    return { ok: false, blocked: fails };
  }
  if (!(await claim(c, ["TRANSMITTED"], "CAPTURE_PENDING"))) return { ok: false, blocked: ["concurrent update"] };
  await audit(caseId, actor, "capture_claimed", { rationale, from: "TRANSMITTED", to: "CAPTURE_PENDING" });
  return finishCapture(caseId);
}

/** Federal capture recorded as COMPLETED: line + payment + case (idempotent; also used by webhooks). */
async function completeFederal(c: FullCase, captureId: string, debugId: string | null) {
  const lines = await getLines(c.id);
  const fed = lines.find((l) => l.kind === "FEDERAL");
  if (fed) await setLine(fed.id, ["AUTHORIZED", "CAPTURE_PENDING", "PENDING"], { status: "COMPLETED", captureId, capturedAt: now(c), lastDebugId: debugId });
  await db.payment.update({ where: { caseId: c.id }, data: { captureId, status: "COMPLETED", lastDebugId: debugId } });
  if (!(await setState(c.id, "CAPTURE_PENDING", "CAPTURED", { capturedAt: now(c) }))) return false;
  await audit(c.id, "system", "state", { from: "CAPTURE_PENDING", to: "CAPTURED" });
  const amt = fed?.amount ?? c.fee;
  await notify(c.id, "preparer", {
    es: `Cobrado ${fmtUSD(amt)} — ${c.clientName}.`,
    en: `Collected ${fmtUSD(amt)} — ${c.clientName}.`,
    pt: `Recebido ${fmtUSD(amt)} — ${c.clientName}.`,
  });
  await notify(c.id, "client", {
    es: `${c.preparer.name} entregó la confirmación del IRS y recibió su pago.`,
    en: `${c.preparer.name} delivered the IRS confirmation and was paid.`,
    pt: `${c.preparer.name} entregou a confirmação do IRS e recebeu o pagamento.`,
  });
  return true;
}

export async function finishCapture(caseId: string): Promise<GuardResult> {
  const c = await load(caseId);
  const authId = c.payment!.authorizationId!;
  const lines = await getLines(caseId);
  const fed = lines.find((l) => l.kind === "FEDERAL");
  const partial = lines.some((l) => l.kind === "STATE");
  const merchant = c.payment?.payeeMerchantId ?? null;
  const fee = merchant ? Math.min(platformFeeCents(), fed?.amount ?? c.fee) : 0;
  // A capture already exists but was PENDING (e.g. under review): look it up instead of capturing again.
  const res = c.payment?.captureId
    ? await paypal.getCapture(c.payment.captureId)
    : await paypal.capture(
        authId,
        `cap-${authId}`,
        partial
          ? { amountCents: fed!.amount, finalCapture: false, invoiceId: `FC-${c.id}-${c.payment!.attempt}-FED`, platformFeeCents: fee, merchantId: merchant }
          : { platformFeeCents: fee, merchantId: merchant },
      );
  const body = res.body as { id?: string; status?: string; details?: Array<{ issue?: string }> } | null;
  await audit(caseId, "paypal", c.payment?.captureId ? "get_capture" : "capture", {
    detail: { status: res.status, pp: body?.status, line: "FEDERAL", partial, finalCapture: !partial, platformFee: fee || undefined },
    debugId: res.debugId ?? undefined,
  });
  if (res.ok && body?.id && fed) await db.feeLine.update({ where: { id: fed.id }, data: { platformFee: fee, lastDebugId: res.debugId } });
  if (res.ok && body?.id && body.status === "PENDING") {
    // Not collected yet: stay in CAPTURE_PENDING; the sweeper / webhook reconciles it.
    await db.payment.update({ where: { caseId }, data: { captureId: body.id, status: "PENDING", lastDebugId: res.debugId } });
    if (fed) await db.feeLine.update({ where: { id: fed.id }, data: { captureId: body.id, status: "PENDING" } });
    return { ok: false, blocked: ["PayPal capture is PENDING; waiting for PayPal to complete it"] };
  }
  if (res.ok && body?.id && body.status !== "COMPLETED") {
    await db.payment.update({ where: { caseId }, data: { captureId: body.id, status: body.status ?? "UNKNOWN" } });
    if (fed) await db.feeLine.update({ where: { id: fed.id }, data: { captureId: body.id, status: body.status ?? "UNKNOWN" } });
    await setState(caseId, "CAPTURE_PENDING", "UNPAID");
    if (partial) await releaseRemainder(c, "federal capture not completed");
    return { ok: false, blocked: [`PayPal capture status ${body.status}`] };
  }
  if (res.ok && body?.id) {
    await completeFederal(c, body.id, res.debugId);
    return { ok: true };
  }
  const issue = body?.details?.[0]?.issue ?? `HTTP ${res.status}`;
  // Recoverable: server errors, expired token, rate limit → the sweeper retries CAPTURE_PENDING.
  if (transient(res.status)) return { ok: false, blocked: [`retry later: ${issue}`] };
  // Possibly already collected (or capture lookup not found yet): stay in CAPTURE_PENDING and reconcile; never void.
  if (issue === "PREVIOUSLY_CAPTURED" || (c.payment?.captureId && res.status === 404))
    return { ok: false, blocked: ["capture state unclear; reconciling with PayPal"] };
  // Before giving up, ask PayPal what the authorization really is: never void money that was in fact collected.
  const a = await paypal.getAuthorization(authId);
  const aStatus = (a.body as { status?: string } | null)?.status;
  await audit(caseId, "paypal", "get_authorization", { detail: { status: a.status, pp: aStatus, issue }, debugId: a.debugId ?? undefined });
  if (aStatus === "CAPTURED" || aStatus === "PARTIALLY_CAPTURED") return { ok: false, blocked: ["already captured at PayPal; reconciling"] };
  if (!a.ok && transient(a.status)) return { ok: false, blocked: [`retry later: authorization lookup HTTP ${a.status}`] };
  // Issuer declined inside the validity window (days 4–29): one re-authorization, then capture on the new id.
  // An EXPIRED authorization can't be re-authorized (and there is nothing left to void).
  if (issue === "INSTRUMENT_DECLINED" && aStatus === "CREATED" && !(await alreadyReauthorized(caseId))) {
    const re = await reauthorize(caseId);
    if (re) return finishCapture(caseId);
  }
  if (issue === "AUTHORIZATION_EXPIRED" || aStatus === "EXPIRED") {
    await setState(caseId, "CAPTURE_PENDING", "UNPAID");
    await db.feeLine.updateMany({ where: { caseId, status: { in: ["AUTHORIZED", "CAPTURE_PENDING"] } }, data: { status: "EXPIRED" } });
    await db.payment.update({ where: { caseId }, data: { status: "EXPIRED" } });
    await audit(caseId, "system", "state", { from: "CAPTURE_PENDING", to: "UNPAID", detail: { issue: "authorization expired" } });
    return { ok: false, blocked: ["authorization expired before the IRS acceptance"] };
  }
  await setState(caseId, "CAPTURE_PENDING", "UNPAID");
  // Do not leave the client's money on hold if we can no longer collect.
  const v = await paypal.void(authId, `void-${c.id}-unpaid`, merchant);
  if (v.ok) await db.feeLine.updateMany({ where: { caseId, status: { in: ["AUTHORIZED", "CAPTURE_PENDING"] } }, data: { status: "VOIDED" } });
  await audit(caseId, "paypal", "void_after_capture_failure", { detail: { status: v.status }, debugId: v.debugId ?? undefined });
  await audit(caseId, "system", "state", { from: "CAPTURE_PENDING", to: "UNPAID", detail: { issue } });
  return { ok: false, blocked: [issue] };
}

// ------------------------------------------------------- state acknowledgment
/** R13 for the state line: the state's acceptance, with a Submission ID from the preparer's EFIN, before the deadline. */
export function stateCaptureConditions(c: FullCase, lines: FeeLine[]): string[] {
  const fails: string[] = [];
  const st = lines.find((l) => l.kind === "STATE");
  const fed = lines.find((l) => l.kind === "FEDERAL");
  if (!st) fails.push("no state fee on this case");
  else if (st.status !== "AUTHORIZED") fails.push(`state line is ${st.status}`);
  if (fed?.status !== "COMPLETED") fails.push("federal fee not collected yet (IRS acceptance first)");
  if (!c.stateAckReceivedAt) fails.push("R13: no state acceptance on file");
  if (!c.stateSubmissionId) fails.push("R13: no state Submission ID registered");
  else if (!c.stateSubmissionId.startsWith(c.preparer.efin)) fails.push("R13: state Submission ID does not start with the preparer's EFIN");
  if (c.ackDeadline && c.stateAckReceivedAt && c.stateAckReceivedAt > c.ackDeadline) fails.push("R13: state acceptance after deadline");
  if (!c.payment?.authorizationId) fails.push("no authorization");
  if (c.payment?.expirationTime && now(c) > c.payment.expirationTime) fails.push("authorization expired");
  return fails;
}

const SID = /^\d{6}\d{4}\d{3}[0-9a-z]{7}$/;

/** Preparer records the state's acceptance (SIMULATED in demo) → capture the state line (final_capture=true). */
export async function stateAckReceived(caseId: string, stateSubmissionId?: string): Promise<GuardResult> {
  const c = await load(caseId);
  if (!["CAPTURED", "CLOSED", "INVESTIGATING"].includes(c.state)) return { ok: false, blocked: [`state acceptance is recorded after the federal capture (state ${c.state})`] };
  if (!c.stateAckReceivedAt) {
    const t = now(c);
    let sid = stateSubmissionId?.trim();
    if (!sid && c.isDemo) {
      const doy = Math.floor((t.getTime() - new Date(t.getFullYear(), 0, 0).getTime()) / 86400_000);
      sid = `${c.preparer.efin}${t.getFullYear()}${String(doy).padStart(3, "0")}st${c.id.slice(-5).toLowerCase().replace(/[^0-9a-z]/g, "0").padEnd(5, "0")}`;
    }
    if (!sid || !SID.test(sid)) return { ok: false, blocked: ["state Submission ID must be 20 characters: EFIN + year + day + 7 letters/digits"] };
    const r = await db.case.updateMany({ where: { id: caseId, stateAckReceivedAt: null }, data: { stateAckReceivedAt: t, stateSubmissionId: sid, version: { increment: 1 } } });
    if (r.count === 1) await audit(caseId, "user", "state_confirmation_uploaded", { detail: { status: "Accepted", simulated: c.isDemo, stateSubmissionId: sid } });
  }
  return captureState(caseId, "system", "State acceptance with preparer EFIN");
}

export async function captureState(caseId: string, actor: "ai" | "system", rationale?: string): Promise<GuardResult> {
  const c = await load(caseId);
  const lines = await getLines(caseId);
  const st = lines.find((l) => l.kind === "STATE");
  if (st && ["COMPLETED", "REFUNDED"].includes(st.status)) return { ok: true, already: true };
  const fails = stateCaptureConditions(c, lines);
  if (fails.length) {
    await audit(caseId, "guardian", "state_capture_blocked", { rationale, detail: { by: actor, conditions: fails } });
    return { ok: false, blocked: fails };
  }
  if (!(await setLine(st!.id, ["AUTHORIZED"], { status: "CAPTURE_PENDING" }))) return { ok: false, blocked: ["concurrent update"] };
  await audit(caseId, actor, "state_capture_claimed", { rationale, detail: { line: "STATE" } });
  return finishLineCapture(caseId, "STATE");
}

export async function finishLineCapture(caseId: string, kind: "STATE"): Promise<GuardResult> {
  const c = await load(caseId);
  const line = (await getLines(caseId)).find((l) => l.kind === kind)!;
  const authId = c.payment!.authorizationId!;
  const merchant = c.payment?.payeeMerchantId ?? null;
  const res = line.captureId
    ? await paypal.getCapture(line.captureId)
    : await paypal.capture(authId, `cap-${authId}-${kind}`, { amountCents: line.amount, finalCapture: true, invoiceId: `FC-${c.id}-${c.payment!.attempt}-${kind}`, merchantId: merchant });
  const body = res.body as { id?: string; status?: string; details?: Array<{ issue?: string }> } | null;
  await audit(caseId, "paypal", line.captureId ? "get_capture" : "capture", { detail: { status: res.status, pp: body?.status, line: kind, finalCapture: true }, debugId: res.debugId ?? undefined });
  if (res.ok && body?.id && body.status === "COMPLETED") {
    await setLine(line.id, ["CAPTURE_PENDING", "PENDING"], { status: "COMPLETED", captureId: body.id, capturedAt: now(c), lastDebugId: res.debugId });
    await notify(caseId, "preparer", {
      es: `Cobrado ${fmtUSD(line.amount)} (declaración estatal) — ${c.clientName}.`,
      en: `Collected ${fmtUSD(line.amount)} (state return) — ${c.clientName}.`,
      pt: `Recebido ${fmtUSD(line.amount)} (declaração estadual) — ${c.clientName}.`,
    });
    return { ok: true };
  }
  if (res.ok && body?.id && body.status === "PENDING") {
    await db.feeLine.update({ where: { id: line.id }, data: { status: "PENDING", captureId: body.id, lastDebugId: res.debugId } });
    return { ok: false, blocked: ["PayPal capture is PENDING; waiting for PayPal to complete it"] };
  }
  if (res.ok && body?.id) {
    await db.feeLine.update({ where: { id: line.id }, data: { status: body.status ?? "UNKNOWN", captureId: body.id } });
    return { ok: false, blocked: [`PayPal capture status ${body.status}`] };
  }
  const issue = body?.details?.[0]?.issue ?? `HTTP ${res.status}`;
  if (transient(res.status)) return { ok: false, blocked: [`retry later: ${issue}`] };
  if (issue === "PREVIOUSLY_CAPTURED" || (line.captureId && res.status === 404)) return { ok: false, blocked: ["capture state unclear; reconciling with PayPal"] };
  await setLine(line.id, ["CAPTURE_PENDING"], { status: "DENIED" });
  await releaseRemainder(c, `state capture failed: ${issue}`);
  return { ok: false, blocked: [issue] };
}

/** Void what's left of a partially captured authorization (client's money must not stay on hold). */
async function releaseRemainder(c: FullCase, reason: string) {
  const authId = c.payment?.authorizationId;
  if (!authId) return false;
  const v = await paypal.void(authId, `void-${authId}-remainder`, c.payment?.payeeMerchantId);
  await audit(c.id, "paypal", "void_remainder", { rationale: reason, detail: { status: v.status }, debugId: v.debugId ?? undefined });
  if (v.ok) await db.feeLine.updateMany({ where: { caseId: c.id, status: "AUTHORIZED" }, data: { status: "VOIDED" } });
  return v.ok;
}

/** Sweeper for fee lines: state deadline, stalled partial captures, pending captures. */
export async function sweepLines(caseId: string, opts: { force?: boolean } = {}) {
  const lines = await db.feeLine.findMany({ where: { caseId, kind: "STATE", status: { in: ["AUTHORIZED", "CAPTURE_PENDING", "PENDING"] } } });
  if (!lines.length) return;
  const c = await load(caseId);
  const st = lines[0];
  const fedDone = !!(await db.feeLine.findFirst({ where: { caseId, kind: "FEDERAL", status: { in: ["COMPLETED", "REFUNDED", "REFUND_PENDING"] } } }));
  if (st.status === "AUTHORIZED" && fedDone && c.ackDeadline && now(c) > c.ackDeadline && !c.stateAckReceivedAt) {
    if (await releaseRemainder(c, "deadline passed without state acceptance"))
      await notify(caseId, "client", {
        es: "El estado no confirmó a tiempo: liberamos la parte estatal de la tarifa.",
        en: "The state did not confirm in time: we released the state part of the fee.",
        pt: "O estado não confirmou a tempo: liberamos a parte estadual da taxa.",
      });
    return;
  }
  const stale = opts.force || Date.now() - st.updatedAt.getTime() > STALE_MS;
  if (stale && (st.status === "CAPTURE_PENDING" || st.status === "PENDING")) await finishLineCapture(caseId, "STATE");
}

export async function sweepAllLines() {
  const open = await db.feeLine.findMany({ where: { kind: "STATE", status: { in: ["AUTHORIZED", "CAPTURE_PENDING", "PENDING"] } }, select: { caseId: true } });
  for (const l of open) {
    try {
      await sweepLines(l.caseId);
    } catch (e) {
      console.error("sweep lines", l.caseId, e);
    }
  }
}

// --------------------------------------------------------------- re-authorize
/** One re-authorization per case (PayPal allows one, on days 4–29). */
export async function alreadyReauthorized(caseId: string) {
  return !!(await db.auditEvent.findFirst({ where: { caseId, action: "reauthorized" } }));
}

/**
 * PayPal honors an authorization for 3 days (valid 29). If the IRS confirmation hasn't arrived by day 4,
 * re-authorize once to get a fresh honor period. Returns true when a new authorization id was stored.
 */
export async function reauthorize(caseId: string): Promise<boolean> {
  const c = await load(caseId);
  const authId = c.payment?.authorizationId;
  if (!authId || (await alreadyReauthorized(caseId))) return false;
  const res = await paypal.reauthorize(authId, c.fee, `reauth-${authId}`, c.payment?.payeeMerchantId);
  const body = res.body as { id?: string; status?: string; expiration_time?: string; details?: Array<{ issue?: string }> } | null;
  await audit(caseId, "paypal", "reauthorize", { detail: { status: res.status, pp: body?.status, issue: body?.details?.[0]?.issue }, debugId: res.debugId ?? undefined });
  if (!res.ok || !body?.id) return false; // e.g. still inside the real-time honor period in sandbox: the original stays valid
  // Only swap the authorization if nothing captured/voided meanwhile; otherwise release the new hold.
  const swapped = await db.payment.updateMany({
    where: { caseId, authorizationId: authId, captureId: null, case: { state: { in: ["AUTHORIZED", "TRANSMITTED", "CAPTURE_PENDING"] } } },
    data: { authorizationId: body.id, status: "AUTHORIZED", expirationTime: body.expiration_time ? new Date(body.expiration_time) : undefined, lastDebugId: res.debugId },
  });
  if (swapped.count !== 1) {
    const v = await paypal.void(body.id, `void-${body.id}-reauth-race`, c.payment?.payeeMerchantId);
    await audit(caseId, "paypal", "void_unused_reauthorization", { detail: { status: v.status }, debugId: v.debugId ?? undefined });
    return false;
  }
  await audit(caseId, "paypal", "reauthorized", { detail: { from: authId, to: body.id }, debugId: res.debugId ?? undefined });
  return true;
}

// ------------------------------------------------------------------------ void
export async function voidAuth(caseId: string, reason: string): Promise<GuardResult> {
  const c = await load(caseId);
  if (c.state === "VOIDED") return { ok: true, already: true };
  const allowed = ["AUTHORIZED", "TRANSMITTED"];
  const fails: string[] = [];
  if (!allowed.includes(c.state)) fails.push(`state is ${c.state}, must be AUTHORIZED or TRANSMITTED`);
  if (c.state === "TRANSMITTED" && reason === "client_cancel") fails.push("client cannot cancel after transmission");
  if (!c.payment?.authorizationId) fails.push("no authorization");
  if (fails.length) {
    await audit(caseId, "guardian", "void_blocked", { detail: { reason, conditions: fails } });
    return { ok: false, blocked: fails };
  }
  if (!(await claim(c, allowed, "VOID_PENDING"))) return { ok: false, blocked: ["concurrent update"] };
  await audit(caseId, "system", "void_claimed", { rationale: reason, from: c.state, to: "VOID_PENDING" });
  return finishVoid(caseId, reason);
}

async function completeVoid(c: FullCase, reason: string, debugId: string | null) {
  await db.payment.update({ where: { caseId: c.id }, data: { status: "VOIDED", lastDebugId: debugId } });
  await db.feeLine.updateMany({ where: { caseId: c.id, status: { in: ["AUTHORIZED", "CAPTURE_PENDING"] } }, data: { status: "VOIDED" } });
  if (!(await setState(c.id, "VOID_PENDING", "VOIDED"))) return false;
  await audit(c.id, "system", "state", { from: "VOID_PENDING", to: "VOIDED", detail: { reason } });
  await notify(c.id, "client", {
    es: "Cancelamos el apartado y el dinero vuelve a estar disponible. Su banco puede tardar unos días.",
    en: "We cancelled the hold; the money is available again. Your bank may take a few days.",
    pt: "Cancelamos a reserva; o dinheiro volta a ficar disponível. Seu banco pode levar alguns dias.",
  });
  await notify(c.id, "preparer", {
    es: `Pago anulado — ${c.clientName} (${reason}).`,
    en: `Payment voided — ${c.clientName} (${reason}).`,
    pt: `Pagamento anulado — ${c.clientName} (${reason}).`,
  });
  return true;
}

export async function finishVoid(caseId: string, reason = "retry"): Promise<GuardResult> {
  const c = await load(caseId);
  const res = await paypal.void(c.payment!.authorizationId!, `void-${c.id}-${c.payment!.attempt}`, c.payment?.payeeMerchantId);
  await audit(caseId, "paypal", "void", { detail: { status: res.status }, debugId: res.debugId ?? undefined });
  if (res.ok) {
    await completeVoid(c, reason, res.debugId);
    return { ok: true };
  }
  // Transient (5xx, expired token, rate limit): stay VOID_PENDING so the sweeper retries. Other 4xx are terminal.
  if (transient(res.status)) return { ok: false, blocked: [`retry later: HTTP ${res.status}`] };
  await setState(caseId, "VOID_PENDING", "VOID_FAILED");
  return { ok: false, blocked: [`HTTP ${res.status}`] };
}

// ---------------------------------------------------------------------- refund
export function refundConditions(c: FullCase): string[] {
  const fails: string[] = [];
  if (c.state !== "REFUND_PROPOSED") fails.push(`state is ${c.state}, must be REFUND_PROPOSED`);
  const windowOver = !!c.refundDeadline && now(c) >= c.refundDeadline;
  if (c.preparerVerdict === "REFUTED") fails.push("preparer evidence refuted the finding");
  if (c.preparerVerdict !== "NOT_REFUTED" && !windowOver) fails.push("preparer 72 h response window still open");
  if (!c.clientConfirmedRefund) fails.push("client has not confirmed");
  if (!c.payment?.captureId) fails.push("no capture to refund");
  if (c.capturedAt && now(c).getTime() - c.capturedAt.getTime() > 150 * 86400_000) fails.push("past 150-day window");
  return fails;
}

export async function refund(caseId: string, actor: "ai" | "system", rationale?: string): Promise<GuardResult> {
  const c = await load(caseId);
  if (c.state === "REFUNDED") return { ok: true, already: true };
  const fails = refundConditions(c);
  if (fails.length) {
    await audit(caseId, "guardian", "refund_blocked", { rationale, detail: { by: actor, conditions: fails } });
    return { ok: false, blocked: fails };
  }
  if (!(await claim(c, ["REFUND_PROPOSED"], "REFUND_PENDING"))) return { ok: false, blocked: ["concurrent update"] };
  await audit(caseId, actor, "refund_claimed", { rationale, from: "REFUND_PROPOSED", to: "REFUND_PENDING" });
  return finishRefund(caseId);
}

/**
 * Refunds every captured line (one PayPal refund per capture; deterministic request ids make retries safe),
 * voids a state line that was never captured, and — multiparty — returns SignClear's platform fee with it.
 */
export async function finishRefund(caseId: string): Promise<GuardResult> {
  const c = await load(caseId);
  const lines = await getLines(caseId);
  const merchant = c.payment?.payeeMerchantId ?? null;
  const note = `${APP_NAME} guarantee: your refund was not delivered as you approved it. Fee returned.`;
  // Legacy cases without lines: one capture, the whole fee.
  const todo = lines.length
    ? lines.filter((l) => ["COMPLETED", "REFUND_PENDING"].includes(l.status) && l.captureId)
    : [{ id: "", kind: "FEDERAL", captureId: c.payment!.captureId!, amount: c.fee, platformFee: 0 } as FeeLine];
  let refunded = lines.filter((l) => l.status === "REFUNDED").reduce((a, l) => a + l.refundedAmount, 0);
  let firstRefundId: string | null = c.payment?.refundId ?? null;
  for (const l of todo) {
    const res = await paypal.refund(l.captureId!, l.kind === "FEDERAL" ? `ref-${c.id}` : `ref-${c.id}-${l.kind}`, l.amount, note, { platformFeeCents: l.platformFee, merchantId: merchant });
    const body = res.body as { id?: string; status?: string; details?: Array<{ issue?: string }> } | null;
    await audit(caseId, "paypal", "refund", { detail: { status: res.status, pp: body?.status, line: l.kind, platformFeeReturned: l.platformFee || undefined }, debugId: res.debugId ?? undefined });
    if (res.ok && body?.id && (body.status === "COMPLETED" || body.status === "PENDING")) {
      if (l.id) await db.feeLine.update({ where: { id: l.id }, data: { status: body.status === "PENDING" ? "REFUND_PENDING" : "REFUNDED", refundId: body.id, refundedAmount: l.amount, lastDebugId: res.debugId } });
      refunded += l.amount;
      firstRefundId = firstRefundId ?? body.id;
      continue;
    }
    if (!res.ok && transient(res.status)) return { ok: false, blocked: ["retry later"] }; // lines already refunded stay refunded; retry resumes
    if (!res.ok && body?.details?.[0]?.issue === "CAPTURE_FULLY_REFUNDED") {
      if (l.id) await db.feeLine.update({ where: { id: l.id }, data: { status: "REFUNDED", refundedAmount: l.amount } });
      refunded += l.amount;
      continue;
    }
    await setState(caseId, "REFUND_PENDING", "REFUND_FAILED");
    return { ok: false, blocked: [res.ok ? `PayPal refund status ${body?.status}` : `HTTP ${res.status}`] };
  }
  // A state line still on hold is released, not refunded.
  if (lines.some((l) => l.status === "AUTHORIZED")) await releaseRemainder(c, "refund: release uncaptured state fee");
  const allPending = lines.length ? (await getLines(caseId)).some((l) => l.status === "REFUND_PENDING") : false;
  await db.payment.update({ where: { caseId }, data: { refundId: firstRefundId, status: allPending ? "REFUND_PENDING_PAYPAL" : "REFUNDED" } });
  await setState(caseId, "REFUND_PENDING", "REFUNDED");
  await audit(caseId, "system", "state", { from: "REFUND_PENDING", to: "REFUNDED", detail: { refunded } });
  await notify(caseId, "client", {
    es: `Le devolvimos ${fmtUSD(refunded)} de la tarifa. Para recuperar el resto, le ayudamos con el formulario 14157-A.`,
    en: `We refunded the ${fmtUSD(refunded)} fee. To recover the rest, we'll help you with Form 14157-A.`,
    pt: `Devolvemos ${fmtUSD(refunded)} da taxa. Para recuperar o restante, ajudamos com o formulário 14157-A.`,
  });
  await notify(caseId, "preparer", {
    es: `Tarifa devuelta — ${c.clientName}.`,
    en: `Fee refunded — ${c.clientName}.`,
    pt: `Taxa devolvida — ${c.clientName}.`,
  });
  return { ok: true };
}

// ------------------------------------------------------- webhook reconciliation
type WhResource = {
  id?: string;
  status?: string;
  custom_id?: string;
  invoice_id?: string;
  amount?: { value?: string };
  supplementary_data?: { related_ids?: { order_id?: string; authorization_id?: string; capture_id?: string } };
  links?: Link[];
};

const upId = (r: WhResource, kind: "captures" | "authorizations") =>
  r.links?.find((l) => l.rel === "up" && l.href.includes(`/${kind}/`))?.href.split(`/${kind}/`)[1]?.split(/[/?]/)[0];

async function caseFor(r: WhResource): Promise<FullCase | null> {
  const ids = [r.custom_id].filter(Boolean) as string[];
  for (const id of ids) {
    const c = await db.case.findUnique({ where: { id }, include: { payment: true, preparer: true } });
    if (c) return c;
  }
  const authId = r.supplementary_data?.related_ids?.authorization_id ?? (r.id && r.id.length ? r.id : undefined);
  const capId = r.supplementary_data?.related_ids?.capture_id ?? upId(r, "captures") ?? r.id;
  const line = capId ? await db.feeLine.findUnique({ where: { captureId: capId } }) : null;
  const p =
    (line && (await db.payment.findUnique({ where: { caseId: line.caseId } }))) ||
    (await db.payment.findFirst({ where: { OR: [{ authorizationId: authId ?? "-" }, { captureId: capId ?? "-" }, { orderId: r.supplementary_data?.related_ids?.order_id ?? "-" }] } }));
  return p ? load(p.caseId) : null;
}

/**
 * Idempotent state reconciliation from a verified webhook. Never captures/voids/refunds on its own initiative:
 * it only records what PayPal says happened and completes transitions SignClear already started.
 */
export async function reconcileWebhook(ev: { id?: string; event_type: string; resource?: WhResource }): Promise<{ caseId: string | null; action: string }> {
  const r = ev.resource ?? {};
  const t = ev.event_type;
  if (t.startsWith("CUSTOMER.DISPUTE.")) {
    const { syncDispute } = await import("./paypal-disputes");
    const d = await syncDispute(r as never, { refresh: true });
    return { caseId: d?.caseId ?? null, action: d ? `dispute:${d.status}` : "dispute:ignored" };
  }
  const c = await caseFor(r);
  if (!c) return { caseId: null, action: "no matching case" };
  const lines = await getLines(c.id);
  const log = (action: string, detail: Record<string, unknown> = {}) => audit(c.id, "paypal", `reconcile:${action}`, { detail: { event: t, eventId: ev.id, ...detail } });

  switch (t) {
    case "PAYMENT.AUTHORIZATION.CREATED": {
      if (c.state !== "MATCH" || !c.payment?.orderId) return { caseId: c.id, action: "noop" };
      const o = await paypal.getOrder(c.payment.orderId);
      const auth = o.ok ? authFromOrder(o.body) : null;
      if (auth && auth.id === r.id && auth.status === "CREATED") {
        await recordAuthorization(c.id, auth, o.debugId);
        await log("authorization_recorded", { authorizationId: auth.id });
        return { caseId: c.id, action: "authorization_recorded" };
      }
      return { caseId: c.id, action: "noop" };
    }
    case "PAYMENT.AUTHORIZATION.VOIDED": {
      if (r.id !== c.payment?.authorizationId) return { caseId: c.id, action: "noop (old authorization)" };
      if (c.state === "VOID_PENDING") {
        await completeVoid(c, "confirmed by PayPal webhook", null);
        await log("void_completed");
        return { caseId: c.id, action: "void_completed" };
      }
      if (["AUTHORIZED", "TRANSMITTED"].includes(c.state)) {
        await db.case.updateMany({ where: { id: c.id, state: c.state }, data: { state: "VOID_PENDING", version: { increment: 1 } } });
        await completeVoid(c, "voided outside SignClear", null);
        await log("voided_outside_signclear");
        return { caseId: c.id, action: "voided_outside_signclear" };
      }
      const n = await db.feeLine.updateMany({ where: { caseId: c.id, status: "AUTHORIZED" }, data: { status: "VOIDED" } });
      if (n.count) await log("remainder_voided");
      return { caseId: c.id, action: n.count ? "remainder_voided" : "noop" };
    }
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.PENDING":
    case "PAYMENT.CAPTURE.DENIED": {
      const capId = r.id!;
      let line = lines.find((l) => l.captureId === capId);
      // Webhook raced our own DB write: attribute it to the line SignClear is capturing.
      if (!line) line = c.state === "CAPTURE_PENDING" ? lines.find((l) => l.kind === "FEDERAL") : lines.find((l) => l.status === "CAPTURE_PENDING");
      if (!line) return { caseId: c.id, action: "noop (unknown capture)" };
      const status = t.split(".").pop()!;
      if (line.status === status || ["REFUNDED", "REFUND_PENDING", "REVERSED"].includes(line.status)) return { caseId: c.id, action: "noop" };
      if (status === "COMPLETED") {
        if (line.kind === "FEDERAL" && c.state === "CAPTURE_PENDING") await completeFederal(c, capId, null);
        else await setLine(line.id, ["AUTHORIZED", "CAPTURE_PENDING", "PENDING"], { status: "COMPLETED", captureId: capId, capturedAt: now(c) });
      } else if (status === "PENDING") {
        await setLine(line.id, ["AUTHORIZED", "CAPTURE_PENDING"], { status: "PENDING", captureId: capId });
        if (line.kind === "FEDERAL") await db.payment.update({ where: { caseId: c.id }, data: { captureId: capId, status: "PENDING" } });
      } else {
        await setLine(line.id, ["AUTHORIZED", "CAPTURE_PENDING", "PENDING"], { status: "DENIED", captureId: capId });
        if (line.kind === "FEDERAL") {
          await db.payment.update({ where: { caseId: c.id }, data: { captureId: capId, status: "DENIED" } });
          if (await setState(c.id, "CAPTURE_PENDING", "UNPAID")) await audit(c.id, "system", "state", { from: "CAPTURE_PENDING", to: "UNPAID", detail: { issue: "capture DENIED" } });
        }
        if (lines.some((l) => l.status === "AUTHORIZED")) await releaseRemainder(c, "capture denied");
      }
      await log(`capture_${status.toLowerCase()}`, { line: line.kind, captureId: capId });
      return { caseId: c.id, action: `capture_${status.toLowerCase()}` };
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      const capId = upId(r, "captures") ?? r.supplementary_data?.related_ids?.capture_id;
      const line = lines.find((l) => l.captureId === capId) ?? (!lines.length && c.payment?.captureId === capId ? null : undefined);
      if (line === undefined) return { caseId: c.id, action: "noop (unknown capture)" };
      if (line && line.status !== "REFUNDED")
        await db.feeLine.update({ where: { id: line.id }, data: { status: "REFUNDED", refundId: line.refundId ?? r.id, refundedAmount: line.amount } });
      if (c.state !== "REFUND_PENDING" && c.state !== "REFUNDED") await log("refund_outside_signclear", { refundId: r.id });
      const after = await getLines(c.id);
      if (after.every((l) => l.status !== "REFUND_PENDING") && c.payment?.status === "REFUND_PENDING_PAYPAL")
        await db.payment.update({ where: { caseId: c.id }, data: { status: "REFUNDED" } });
      await log("refund_confirmed", { refundId: r.id, captureId: capId });
      return { caseId: c.id, action: "refund_confirmed" };
    }
    case "PAYMENT.CAPTURE.REVERSED": {
      const capId = lines.find((l) => l.captureId === r.id) ? r.id : upId(r, "captures");
      const line = lines.find((l) => l.captureId === capId);
      if (!line || line.status === "REVERSED") return { caseId: c.id, action: "noop" };
      await db.feeLine.update({ where: { id: line.id }, data: { status: "REVERSED" } });
      await db.payment.update({ where: { caseId: c.id }, data: { status: "REVERSED" } });
      await log("capture_reversed", { line: line.kind, captureId: capId });
      await notify(c.id, "preparer", {
        es: `PayPal revirtió el cobro de ${fmtUSD(line.amount)} — ${c.clientName}. Revise la disputa.`,
        en: `PayPal reversed the ${fmtUSD(line.amount)} capture — ${c.clientName}. Check the dispute.`,
        pt: `O PayPal reverteu a cobrança de ${fmtUSD(line.amount)} — ${c.clientName}. Verifique a disputa.`,
      });
      return { caseId: c.id, action: "capture_reversed" };
    }
  }
  return { caseId: c.id, action: "logged" };
}

// ------------------------------------------------------------ read-only status
/** Read-only PayPal status for the agent and the desk: live order status + lines + disputes on file. */
export async function paymentStatus(caseId: string) {
  const c = await load(caseId);
  if (!c.payment?.orderId) return { order: null, lines: [], disputes: [] };
  const o = await paypal.getOrder(c.payment.orderId);
  await audit(caseId, "paypal", "get_order", { debugId: o.debugId ?? undefined, detail: { status: o.status } });
  const ob = o.body as { status?: string } | null;
  const lines = await getLines(caseId);
  const disputes = await db.dispute.findMany({ where: { caseId } });
  return {
    order: { id: c.payment.orderId, status: ob?.status ?? `HTTP ${o.status}` },
    authorization: { id: c.payment.authorizationId, expires: c.payment.expirationTime?.toISOString().slice(0, 10) ?? null },
    multiparty: !!c.payment.payeeMerchantId,
    lines: lines.map((l) => ({ kind: l.kind, amount: fmtUSD(l.amount), status: l.status, captureId: l.captureId, refundId: l.refundId })),
    disputes: disputes.map((d) => ({ id: d.disputeId, status: d.status, reason: d.reason, stage: d.stage })),
  };
}
