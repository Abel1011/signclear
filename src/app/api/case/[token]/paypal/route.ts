import { NextResponse } from "next/server";
import { resolveToken } from "@/lib/view";
import { db } from "@/lib/db";
import * as money from "@/lib/money";

export const dynamic = "force-dynamic";

// Client-only: create the AUTHORIZE order (amount always from DB) and authorize after onApprove.
// step "seat": demo judge seat — authorize server-side with the vaulted sandbox wallet.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const who = await resolveToken(token);
  if (!who || who.role !== "client") return NextResponse.json({ error: "not allowed" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { step?: "create" | "authorize" | "seat"; orderID?: string };
  if (body.step === "create") {
    const r = await money.createOrder(who.caseId);
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }
  if (body.step === "seat") {
    const r = await money.seatAuthorize(who.caseId);
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }
  const r = await money.authorizeOrder(who.caseId, String(body.orderID));
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}

/** Fee breakdown (federal / state lines) for the approval modal and the payment steps. Either role. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const who = await resolveToken(token);
  if (!who) return NextResponse.json({ error: "invalid link" }, { status: 404 });
  const c = await db.case.findUniqueOrThrow({ where: { id: who.caseId } });
  const lines = await money.getLines(who.caseId);
  return NextResponse.json({
    split: money.feeSplit(c).map((l) => ({ kind: l.kind, amount: l.amountCents })),
    lines: lines.map((l) => ({ kind: l.kind, amount: l.amount, status: l.status, captureId: l.captureId, refundId: l.refundId })),
    seat: !!process.env.PAYPAL_SEAT_VAULT_ID && c.isDemo && c.state === "MATCH",
  });
}
