import { NextResponse, after } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { runAgent } from "@/lib/agent";
import { isSeat, seedSeat, type SeatResult } from "./seed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Seeding is local DB work plus (collect/short) a few PayPal sandbox calls (~5 s). Never let the request hang:
 *  past this budget the caller gets a clear, retryable JSON error instead of a dropped connection. */
const SEED_BUDGET_MS = 25_000;

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

// One-click judge seat: a fresh, private desk with ONE sample case already at the interesting moment.
const hits = new Map<string, number[]>();
export async function POST(req: Request) {
  const ip = (process.env.TRUST_PROXY === "1" ? req.headers.get("x-forwarded-for")?.split(",")[0].trim() : null) ?? "local";
  const t = Date.now();
  const arr = (hits.get(ip) ?? []).filter((x) => t - x < 10 * 60_000);
  arr.push(t);
  hits.set(ip, arr);
  if (arr.length > 12) return json({ error: "Too many sample cases; try again in a few minutes.", code: "rate_limited", retryable: false }, 429);
  const body = (await req.json().catch(() => ({}))) as { seat?: string; lang?: string };
  if (!isSeat(body.seat)) return json({ error: "Unknown sample case.", code: "unknown_seat", retryable: false }, 400);
  const lang = ["es", "en", "pt"].includes(String(body.lang)) ? String(body.lang) : "en"; // judges read English first; María's language is one click away
  const session = crypto.randomBytes(12).toString("hex");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), SEED_BUDGET_MS)));
    const r = await Promise.race([seedSeat(session, body.seat, { lang }), timeout]);
    if (r === "timeout") {
      console.error("seat timeout", body.seat);
      return json({ error: "The sample case is taking too long (PayPal sandbox is slow). Please try again.", code: "timeout", retryable: true }, 504);
    }
    const res: SeatResult = r;
    (await cookies()).set("fc_demo", session, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
    // Clara explains in the background, after the response is sent; the deterministic banner is on screen immediately.
    after(async () => {
      for (const k of res.kicks) await runAgent(k.caseId, k.event, k.payload ?? {}).catch((e) => console.error("seat agent", e));
    });
    return json({ seat: res.seat, target: res.target, reached: res.reached, state: res.state, note: res.note, cases: [res.case], ms: Date.now() - t });
  } catch (e) {
    console.error("seat error", e);
    return json({ error: "Could not open the sample case. Please try again.", code: "seed_failed", retryable: true }, 500);
  } finally {
    clearTimeout(timer);
  }
}
