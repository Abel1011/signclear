import { NextResponse } from "next/server";
import { resolveToken } from "@/lib/view";
import { db } from "@/lib/db";
import * as money from "@/lib/money";
import * as disputes from "@/lib/paypal-disputes";
import { onboardingStatus, startOnboarding } from "@/lib/paypal-partner";

export const dynamic = "force-dynamic";

async function preparerCase(token: string) {
  const who = await resolveToken(token);
  if (!who || who.role !== "preparer") return null;
  return db.case.findUniqueOrThrow({ where: { id: who.caseId } });
}

/** PayPal depth for the preparer desk: fee lines, disputes (with allowed actions), onboarding status. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const c = await preparerCase((await params).token);
  if (!c) return NextResponse.json({ error: "not allowed" }, { status: 403 });
  const [lines, ds, onboarding] = await Promise.all([money.getLines(c.id), disputes.disputesView(c.id), onboardingStatus(c.preparerId)]);
  return NextResponse.json({
    caseId: c.id,
    state: c.state,
    stateFee: c.stateFee,
    stateSubmissionId: c.stateSubmissionId,
    stateAckReceivedAt: c.stateAckReceivedAt,
    lines: lines.map((l) => ({ kind: l.kind, amount: l.amount, platformFee: l.platformFee, status: l.status, captureId: l.captureId, refundId: l.refundId })),
    disputes: ds,
    onboarding,
    platformFee: money.platformFeeCents(),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const c = await preparerCase(token);
  if (!c) return NextResponse.json({ error: "not allowed" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { action?: string; stateCents?: number; stateSubmissionId?: string; disputeId?: string; note?: string };
  try {
    switch (b.action) {
      case "set_state_fee":
        return NextResponse.json(await money.setStateFee(c.id, Math.round(Number(b.stateCents))));
      case "state_ack":
        return NextResponse.json(await money.stateAckReceived(c.id, b.stateSubmissionId ? String(b.stateSubmissionId).slice(0, 20) : undefined));
      case "poll_disputes":
        return NextResponse.json(await disputes.pollDisputes());
      case "evidence_preview": {
        const pkg = await disputes.buildEvidence(c.id);
        return NextResponse.json({ notes: disputes.evidenceNotes(pkg), package: pkg });
      }
      case "provide_evidence":
        return NextResponse.json(await disputes.provideEvidence(c.id, String(b.disputeId ?? "")));
      case "accept_claim":
        return NextResponse.json(await disputes.acceptClaim(c.id, String(b.disputeId ?? ""), String(b.note ?? "").slice(0, 2000)));
      case "connect": {
        const origin = new URL(req.url).origin;
        const r = await startOnboarding(c.preparerId, `${origin}/api/preparer/paypal/return?desk=${encodeURIComponent(`/p/${token}`)}`);
        return NextResponse.json(r, { status: r.ok ? 200 : 409 });
      }
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    console.error("preparer paypal", b.action, String(e).slice(0, 200));
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 400 });
  }
}
