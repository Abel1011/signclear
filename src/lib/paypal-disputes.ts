// PayPal Disputes (Customer Disputes API v1): sync from webhooks / polling, evidence package from the
// case record, and preparer actions gated by the dispute's own HATEOAS links.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { db } from "./db";
import { audit, notify } from "./audit";
import { paypal, toCents, type DisputeResource, type Link } from "./paypal";
import { fmtUSD } from "./i18n";
import type { Values } from "./rules";

export type DisputeAction = "provide_evidence" | "accept_claim";

/** Only the actions PayPal currently offers on this dispute (HATEOAS). rel names are normalized (- → _). */
export function allowedActions(links: Link[] | null | undefined): DisputeAction[] {
  const rels = new Set((links ?? []).map((l) => l.rel.replace(/-/g, "_").toLowerCase()));
  return (["provide_evidence", "accept_claim"] as const).filter((a) => rels.has(a));
}

async function caseForDispute(d: DisputeResource): Promise<{ caseId: string | null; captureId: string | null }> {
  for (const t of d.disputed_transactions ?? []) {
    const cap = t.seller_transaction_id ?? null;
    if (cap) {
      const line = await db.feeLine.findUnique({ where: { captureId: cap } });
      if (line) return { caseId: line.caseId, captureId: cap };
      const p = await db.payment.findFirst({ where: { captureId: cap } });
      if (p) return { caseId: p.caseId, captureId: cap };
    }
    if (t.custom && (await db.case.findUnique({ where: { id: t.custom } }))) return { caseId: t.custom, captureId: cap };
    const inv = t.invoice_number?.match(/^FC-(.+)-\d+(?:-[A-Z]+)?$/)?.[1];
    if (inv && (await db.case.findUnique({ where: { id: inv } }))) return { caseId: inv, captureId: cap };
  }
  return { caseId: null, captureId: d.disputed_transactions?.[0]?.seller_transaction_id ?? null };
}

/** Upsert a dispute from a webhook resource or a GET. refresh=true re-reads it so links/status are authoritative. */
export async function syncDispute(resource: DisputeResource, opts: { refresh?: boolean } = {}) {
  if (!resource?.dispute_id) return null;
  let d = resource;
  let debugId: string | null = null;
  if (opts.refresh) {
    const g = await paypal.getDispute(resource.dispute_id);
    if (g.ok && g.body) {
      d = g.body;
      debugId = g.debugId;
    }
  }
  const { caseId, captureId } = await caseForDispute(d);
  const prev = await db.dispute.findUnique({ where: { disputeId: d.dispute_id } });
  const data = {
    caseId,
    captureId,
    reason: d.reason ?? prev?.reason ?? null,
    status: d.status ?? prev?.status ?? null,
    stage: d.dispute_life_cycle_stage ?? prev?.stage ?? null,
    amount: d.dispute_amount ? toCents(d.dispute_amount) : (prev?.amount ?? null),
    sellerResponseDue: d.seller_response_due_date ? new Date(d.seller_response_due_date) : (prev?.sellerResponseDue ?? null),
    links: JSON.stringify(d.links ?? JSON.parse(prev?.links ?? "[]")),
    outcome: d.dispute_outcome?.outcome_code ?? prev?.outcome ?? null,
    lastDebugId: debugId ?? prev?.lastDebugId ?? null,
  };
  const row = await db.dispute.upsert({ where: { disputeId: d.dispute_id }, create: { disputeId: d.dispute_id, ...data }, update: data });
  if (caseId && (!prev || prev.status !== row.status)) {
    await audit(caseId, "paypal", prev ? "dispute_updated" : "dispute_opened", { debugId: debugId ?? undefined, detail: { disputeId: row.disputeId, status: row.status, reason: row.reason, stage: row.stage } });
    if (!prev) {
      const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
      await notify(caseId, "preparer", {
        es: `${c.clientName} abrió un caso en PayPal (${row.reason ?? "disputa"}) por ${fmtUSD(row.amount ?? 0)}. Tiene un paquete de evidencia listo.`,
        en: `${c.clientName} opened a PayPal case (${row.reason ?? "dispute"}) for ${fmtUSD(row.amount ?? 0)}. An evidence package is ready.`,
        pt: `${c.clientName} abriu uma disputa no PayPal (${row.reason ?? "disputa"}) de ${fmtUSD(row.amount ?? 0)}. Um pacote de evidências está pronto.`,
      });
    }
  }
  return row;
}

/** Polling fallback for missed webhooks: GET /v1/customer/disputes, then GET each one. */
export async function pollDisputes(days = 30) {
  // The Disputes API wants milliseconds (INVALID_START_TIME_FORMAT without them; verified in sandbox).
  const start = new Date(Date.now() - days * 86400_000).toISOString();
  const list = await paypal.listDisputes({ startTime: start, pageSize: 50 });
  if (!list.ok) return { ok: false, status: list.status, debugId: list.debugId, synced: 0 };
  let synced = 0;
  for (const item of list.body?.items ?? []) {
    const known = await db.dispute.findUnique({ where: { disputeId: item.dispute_id } });
    if (known && known.status === item.status) continue;
    if (await syncDispute(item as DisputeResource, { refresh: true })) synced++;
  }
  return { ok: true, status: list.status, debugId: list.debugId, synced, total: list.body?.items?.length ?? 0 };
}

// ------------------------------------------------------------ evidence package
export type EvidencePackage = {
  caseId: string;
  client: string;
  preparer: { name: string; business: string; ptin: string; efin: string };
  service: string;
  approved: { at: string | null; refund: number | null; refundAccountLast4: string | null; fee: number; authorizationId: string | null; payerName: string | null };
  consent7216: { at: string; detail: unknown } | null;
  irs: { submissionId: string | null; transmittedAt: string | null; acceptedAt: string | null };
  state: { submissionId: string | null; acceptedAt: string | null } | null;
  captures: { kind: string; captureId: string | null; amount: number; status: string }[];
  auditTrail: { at: string; actor: string; action: string; debugId: string | null }[];
};

/** Built only from what SignClear recorded: the approved snapshot, the 7216 consent, the IRS acceptance and Submission ID. */
export async function buildEvidence(caseId: string): Promise<EvidencePackage> {
  const c = await db.case.findUniqueOrThrow({ where: { id: caseId }, include: { preparer: true, payment: true, snapshot: true, feeLines: true } });
  const ev = await db.auditEvent.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  const consent = ev.find((e) => e.action === "consent_and_intake");
  const intake = await db.intake.findUnique({ where: { caseId } });
  const snap = JSON.parse(c.snapshot?.data ?? "{}") as Values;
  const KEY = new Set(["consent_and_intake", "authorization_recorded", "state", "irs_confirmation_uploaded", "state_confirmation_uploaded", "capture", "refund", "void"]);
  return {
    caseId,
    client: c.clientName,
    preparer: { name: c.preparer.name, business: c.preparer.business, ptin: c.preparer.ptin, efin: c.preparer.efin },
    service: c.stateFee > 0 ? "Federal and state income tax return preparation and e-file" : "Federal income tax return preparation and e-file",
    approved: {
      at: c.approvedAt?.toISOString() ?? null,
      refund: typeof snap.refund === "number" ? snap.refund : null,
      refundAccountLast4: intake ? ((JSON.parse(intake.data) as { refundAcctLast4?: string }).refundAcctLast4 ?? null) : null,
      fee: c.fee,
      authorizationId: c.payment?.authorizationId ?? null,
      payerName: c.payment?.payerName ?? null,
    },
    consent7216: consent ? { at: consent.createdAt.toISOString(), detail: JSON.parse(consent.detail) } : null,
    irs: { submissionId: c.submissionId, transmittedAt: c.transmittedAt?.toISOString() ?? null, acceptedAt: c.ackReceivedAt?.toISOString() ?? null },
    state: c.stateFee > 0 ? { submissionId: c.stateSubmissionId, acceptedAt: c.stateAckReceivedAt?.toISOString() ?? null } : null,
    captures: c.feeLines.map((l) => ({ kind: l.kind, captureId: l.captureId, amount: l.amount, status: l.status })),
    auditTrail: ev.filter((e) => KEY.has(e.action)).map((e) => ({ at: e.createdAt.toISOString(), actor: e.actor, action: e.action, debugId: e.debugId })),
  };
}

export function evidenceNotes(p: EvidencePackage): string {
  const lines = [
    `Service: ${p.service} by ${p.preparer.business} (PTIN ${p.preparer.ptin}, EFIN ${p.preparer.efin}) for ${p.client}.`,
    p.consent7216 ? `Client signed IRC 7216 consent on ${p.consent7216.at.slice(0, 10)}.` : "No 7216 consent on file.",
    p.approved.at ? `Client approved the return on ${p.approved.at.slice(0, 10)} (approved refund ${p.approved.refund != null ? fmtUSD(p.approved.refund) : "n/a"}); PayPal authorization ${p.approved.authorizationId}.` : "",
    p.irs.acceptedAt ? `IRS accepted the e-filed return on ${p.irs.acceptedAt.slice(0, 10)}, Submission ID ${p.irs.submissionId}. The fee was captured only after this acceptance.` : "No IRS acceptance on file.",
    p.state?.acceptedAt ? `State accepted on ${p.state.acceptedAt.slice(0, 10)}, Submission ID ${p.state.submissionId}.` : "",
  ];
  return lines.filter(Boolean).join(" ").slice(0, 2000);
}

/** One-page PDF with the package (PayPal accepts PDF evidence files). No SSN/PII beyond the case record. */
export async function evidencePdf(p: EvidencePackage): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 750;
  const ascii = (s: string) => s.normalize("NFD").replace(/[^\x20-\x7e]/g, "");
  const line = (s: string, f = font, size = 10) => {
    for (let i = 0; i < s.length; i += 95) {
      page.drawText(ascii(s.slice(i, i + 95)), { x: 50, y, size, font: f });
      y -= size + 5;
    }
  };
  line("SignClear - evidence package", bold, 14);
  y -= 6;
  for (const s of evidenceNotes(p).split(/(?<=\.) /)) line(s);
  y -= 8;
  line("Captures", bold, 11);
  for (const cpt of p.captures) line(`${cpt.kind}: ${fmtUSD(cpt.amount)} - capture ${cpt.captureId ?? "-"} - ${cpt.status}`);
  y -= 8;
  line("Audit trail (append-only)", bold, 11);
  for (const a of p.auditTrail.slice(-25)) line(`${a.at.replace("T", " ").slice(0, 19)}  ${a.actor}  ${a.action}${a.debugId ? `  debug-id ${a.debugId}` : ""}`, font, 8);
  return doc.save();
}

// ----------------------------------------------------------- preparer actions
export async function provideEvidence(caseId: string, disputeId: string) {
  const d = await db.dispute.findUnique({ where: { disputeId } });
  if (!d || d.caseId !== caseId) return { ok: false, blocked: ["dispute not found for this case"] };
  if (!allowedActions(JSON.parse(d.links)).includes("provide_evidence")) return { ok: false, blocked: ["PayPal does not allow providing evidence on this dispute now"] };
  const pkg = await buildEvidence(caseId);
  const pdf = await evidencePdf(pkg);
  const name = `signclear-evidence-${caseId.slice(-6)}.pdf`;
  const input = { evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", notes: evidenceNotes(pkg), documents: [{ name }] }] };
  const res = await paypal.provideEvidence(disputeId, input, { name, bytes: pdf, type: "application/pdf" });
  await audit(caseId, "paypal", "dispute_provide_evidence", { debugId: res.debugId ?? undefined, detail: { disputeId, status: res.status } });
  if (!res.ok) return { ok: false, blocked: [`PayPal error ${res.status}`], debugId: res.debugId };
  await db.dispute.update({ where: { disputeId }, data: { evidenceSubmittedAt: new Date() } });
  await syncDispute({ dispute_id: disputeId }, { refresh: true });
  return { ok: true, debugId: res.debugId };
}

export async function acceptClaim(caseId: string, disputeId: string, note: string) {
  const d = await db.dispute.findUnique({ where: { disputeId } });
  if (!d || d.caseId !== caseId) return { ok: false, blocked: ["dispute not found for this case"] };
  if (!allowedActions(JSON.parse(d.links)).includes("accept_claim")) return { ok: false, blocked: ["PayPal does not allow accepting this claim now"] };
  const res = await paypal.acceptClaim(disputeId, note || "The preparer accepts the claim; the fee is returned to the client.");
  await audit(caseId, "paypal", "dispute_accept_claim", { debugId: res.debugId ?? undefined, detail: { disputeId, status: res.status } });
  if (!res.ok) return { ok: false, blocked: [`PayPal error ${res.status}`], debugId: res.debugId };
  await db.dispute.update({ where: { disputeId }, data: { claimAcceptedAt: new Date() } });
  await syncDispute({ dispute_id: disputeId }, { refresh: true });
  return { ok: true, debugId: res.debugId };
}

/** Desk view of a case's disputes, with only PayPal-allowed actions. */
export async function disputesView(caseId: string) {
  const rows = await db.dispute.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  return rows.map((d) => ({
    disputeId: d.disputeId,
    reason: d.reason,
    status: d.status,
    stage: d.stage,
    amount: d.amount,
    sellerResponseDue: d.sellerResponseDue,
    outcome: d.outcome,
    evidenceSubmittedAt: d.evidenceSubmittedAt,
    claimAcceptedAt: d.claimAcceptedAt,
    actions: allowedActions(JSON.parse(d.links)),
  }));
}
