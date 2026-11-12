import { NextResponse } from "next/server";
import { resolveToken, caseView, auditView } from "@/lib/view";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const who = await resolveToken(token);
  if (!who) return NextResponse.json({ error: "Este enlace no es válido / This link is not valid" }, { status: 404 });
  const view = await caseView(who.caseId, who.role);
  const url = new URL(req.url);
  const withAudit = url.searchParams.get("audit") === "1" && view.isDemo;
  return NextResponse.json({ ...view, audit: withAudit ? await auditView(who.caseId) : undefined }, {
    headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" },
  });
}
