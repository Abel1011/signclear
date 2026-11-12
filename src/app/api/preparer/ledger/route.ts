import { NextResponse } from "next/server";
import { resolveToken } from "@/lib/view";
import { reconcileLedger } from "@/lib/paypal-ledger";

export const dynamic = "force-dynamic";

/** Ledger reconciliation for the cases behind the given preparer tokens (body, not URL: tokens are capabilities). */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { tokens?: unknown; days?: number };
  const tokens = Array.isArray(b.tokens) ? b.tokens.slice(0, 50).map(String) : [];
  const ids: string[] = [];
  for (const t of tokens) {
    const who = await resolveToken(t);
    if (who?.role === "preparer") ids.push(who.caseId);
  }
  if (!ids.length) return NextResponse.json({ error: "no cases" }, { status: 400 });
  try {
    return NextResponse.json(await reconcileLedger(ids, Number(b.days) || 30));
  } catch (e) {
    console.error("ledger", String(e).slice(0, 200));
    return NextResponse.json({ error: "Could not reach PayPal. Try again." }, { status: 502 });
  }
}
