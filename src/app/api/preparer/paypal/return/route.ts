import { NextResponse } from "next/server";
import { completeOnboarding } from "@/lib/paypal-partner";

export const dynamic = "force-dynamic";

/** Partner Referrals return URL: store the seller's merchant id, then go back to the desk. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const r = await completeOnboarding(u.searchParams);
  const desk = u.searchParams.get("desk") ?? "/";
  const back = /^\/p\/[A-Za-z0-9_-]{10,64}$/.test(desk) ? desk : "/";
  return NextResponse.redirect(new URL(`${back}?paypal=${r.ok ? "connected" : "not_connected"}`, u.origin));
}
