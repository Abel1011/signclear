import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import * as engine from "@/lib/engine";
import { SEATS, seatOf } from "../seats/seed";

export const dynamic = "force-dynamic";

const hits = new Map<string, number[]>();
function limited(key: string, max = 15, windowMs = 10 * 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
const LANGS = new Set(["es", "en", "pt"]);
const DESK_SCENARIOS = ["live", ...SEATS.map((s) => `seat-${s}`)];

async function session() {
  const v = (await cookies()).get("fc_demo")?.value ?? null;
  return v && /^[0-9a-f]{24}$/.test(v) ? v : null; // only random desk ids; never the arena world
}

/** The preparer's cases in this sandbox desk (their own cases and, for a judge seat, the sample case). */
export async function GET() {
  const s = await session();
  if (!s) return NextResponse.json({ cases: [] });
  const rows = await db.case.findMany({ where: { demoSession: s, scenario: { in: DESK_SCENARIOS } }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({
    seat: seatOf(rows[0]?.scenario),
    cases: rows.map((c) => ({ name: c.clientName, client: c.clientToken, preparer: c.preparerToken })),
  });
}

/** The preparer opens a new case for a client. */
export async function POST(req: Request) {
  const s = await session();
  if (!s) return NextResponse.json({ error: "open the desk first" }, { status: 401 });
  if (limited(s)) return NextResponse.json({ error: "too many cases; try again in a few minutes" }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as { clientName?: string; lang?: string; fee?: number };
  const name = String(b.clientName ?? "").trim().slice(0, 60);
  const lang = LANGS.has(String(b.lang)) ? String(b.lang) : "en";
  const fee = Math.round(Number(b.fee) * 100);
  if (name.length < 3) return NextResponse.json({ error: "client name is required" }, { status: 400 });
  if (!Number.isFinite(fee) || fee < 1000 || fee > 200_000) return NextResponse.json({ error: "fee must be between $10 and $2,000" }, { status: 400 });
  const c = await engine.createCase(s, name, lang, fee);
  return NextResponse.json({ name: c.clientName, client: c.clientToken, preparer: c.preparerToken });
}
