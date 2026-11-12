import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

// Opens a fresh, private sandbox desk for this visitor. No cases, answers or documents are pre-loaded:
// the visitor creates the case as the preparer and answers as the client.
const hits = new Map<string, number[]>();
export async function POST(req: Request) {
  const ip = (process.env.TRUST_PROXY === "1" ? req.headers.get("x-forwarded-for")?.split(",")[0].trim() : null) ?? "local";
  const t = Date.now();
  const arr = (hits.get(ip) ?? []).filter((x) => t - x < 10 * 60_000);
  arr.push(t);
  hits.set(ip, arr);
  if (arr.length > 10) return NextResponse.json({ error: "Too many new desks; try again in a few minutes." }, { status: 429 });
  const session = crypto.randomBytes(12).toString("hex");
  const jar = await cookies();
  jar.set("fc_demo", session, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
  return NextResponse.json({ ok: true });
}
