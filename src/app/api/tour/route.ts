import { NextResponse, after } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { resolveToken } from "@/lib/view";
import { runAgent } from "@/lib/agent";
import { seedSeat } from "../desk/seats/seed";
import { TOUR_STEPS, runTourStep, tourPosition } from "@/lib/tour";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The 90-second story: start = a fresh private sample case at the fraud moment; step = advance it with the real engine.
const hits = new Map<string, number[]>();
function limited(key: string, max: number) {
  const t = Date.now();
  const arr = (hits.get(key) ?? []).filter((x) => t - x < 10 * 60_000);
  arr.push(t);
  hits.set(key, arr);
  return arr.length > max;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; token?: string; step?: number };
  const ip = (process.env.TRUST_PROXY === "1" ? req.headers.get("x-forwarded-for")?.split(",")[0].trim() : null) ?? "local";
  try {
    if (body.action === "start") {
      if (limited(`start:${ip}`, 10)) return NextResponse.json({ error: "Too many stories started; try again in a few minutes." }, { status: 429 });
      const session = crypto.randomBytes(12).toString("hex");
      const r = await seedSeat(session, "fraud", { lang: "en", authorize: null });
      const c = await db.case.findUniqueOrThrow({ where: { clientToken: r.case.client } });
      await audit(c.id, "system", "tour_started", { detail: { story: "90s" } });
      (await cookies()).set("fc_demo", session, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
      after(async () => {
        for (const k of r.kicks) await runAgent(k.caseId, k.event, k.payload ?? {}).catch((e) => console.error("tour agent", e));
      });
      return NextResponse.json({ case: r.case, state: r.state, position: 1, steps: TOUR_STEPS });
    }
    if (body.action === "step") {
      const who = await resolveToken(String(body.token ?? ""));
      if (!who || who.role !== "preparer") return NextResponse.json({ error: "invalid link" }, { status: 404 });
      const c = await db.case.findUniqueOrThrow({ where: { id: who.caseId } });
      const isTour = c.isDemo && !!(await db.auditEvent.findFirst({ where: { caseId: c.id, action: "tour_started" } }));
      if (!isTour) return NextResponse.json({ error: "not a story case" }, { status: 403 });
      if (limited(`step:${c.id}`, 40)) return NextResponse.json({ error: "Too many steps; please wait a minute." }, { status: 429 });
      const step = Number(body.step);
      if (!Number.isInteger(step) || step < 1 || step >= TOUR_STEPS.length) return NextResponse.json({ error: "unknown step" }, { status: 400 });
      const r = await runTourStep(c.id, step);
      // Clara explains in the background; captions never wait for the model.
      if (r.kick && !r.already) after(() => runAgent(c.id, r.kick!.event, r.kick!.payload ?? {}).catch((e) => console.error("tour agent", e)));
      return NextResponse.json({ ...r, kick: undefined, position: await tourPosition(c.id) });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    console.error("tour error", msg);
    const internal = /prisma|invalid `|ECONN|fetch failed|token|oauth|stack/i.test(msg) || msg.length > 240;
    return NextResponse.json({ error: internal ? "Something went wrong on the server. Please retry this step." : msg }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const who = await resolveToken(token);
  if (!who || who.role !== "preparer") return NextResponse.json({ error: "invalid link" }, { status: 404 });
  return NextResponse.json({ position: await tourPosition(who.caseId), steps: TOUR_STEPS });
}
