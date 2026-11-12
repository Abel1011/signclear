import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { allCases } from "@/lib/lab/data";
import { evaluateCase } from "@/lib/lab/evaluate";
import { costOf } from "@/lib/lab/metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// "Try one live": runs the real quarantined reader on ONE synthetic corpus document (clean PDF, scan or photo),
// then the production rules exactly as engine.ts runs them.
// At most 1 concurrent read, 4 per client per 10 min, 40 per hour overall (it spends real API credit).
let busy = false;
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return true;
  arr.push(now);
  hits.set(key, arr);
  return false;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { caseKey?: string };
  const c = allCases().find((x) => x.key === body.caseKey);
  if (!c) return NextResponse.json({ error: "unknown case" }, { status: 404 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "live reader not configured" }, { status: 503 });
  if (busy) return NextResponse.json({ error: "Another live read is running. Try again in a few seconds." }, { status: 429 });
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  if (limited(`ip:${ip}`, 4, 10 * 60_000) || limited("global", 40, 60 * 60_000))
    return NextResponse.json({ error: "Rate limit reached for live reads. The stored runs show every case." }, { status: 429 });
  busy = true;
  try {
    const { readDocumentLive, toValues, accuracy } = await import("@/lib/reader");
    const base64 = readFileSync(path.join(process.cwd(), "public", c.doc ?? c.pdf)).toString("base64");
    const r = await readDocumentLive({ base64, mediaType: c.mediaType ?? "application/pdf" }, AbortSignal.timeout(100_000));
    const values = toValues(r.rows);
    const ev = evaluateCase(c, values, c.preparerKey);
    const truth = { ...c.truth } as Record<string, unknown>;
    delete truth.sums_ok;
    const acc = accuracy(values, truth as never);
    const u = r.usage as { input_tokens: number; output_tokens: number };
    return NextResponse.json({
      caseKey: c.key,
      model: r.model,
      latencyMs: r.latencyMs,
      tokensIn: u.input_tokens,
      tokensOut: u.output_tokens,
      costUsd: costOf(r.model, u.input_tokens, u.output_tokens),
      reader: acc,
      condition: c.condition ?? "pdf",
      production: ev.production,
      core: ev.core,
      values: ev.values,
    });
  } catch (e) {
    return NextResponse.json({ error: `Live read failed: ${String(e).slice(0, 160)}` }, { status: 502 });
  } finally {
    busy = false;
  }
}
