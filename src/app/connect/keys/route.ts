// API-key management for the preparer's sandbox desk (cookie session). The full key is returned once.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/platform/keys";
import { rateLimited, clientIp } from "@/lib/platform/ratelimit";

export const dynamic = "force-dynamic";

async function session(create: boolean) {
  const jar = await cookies();
  let s = jar.get("fc_demo")?.value ?? null;
  if (s && !/^[0-9a-f]{24}$/.test(s)) s = null;
  if (!s && create) {
    // Same cookie as the preparer desk: cases created with this key show up in that desk.
    s = crypto.randomBytes(12).toString("hex");
    jar.set("fc_demo", s, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
  }
  return s;
}

export async function GET() {
  const s = await session(false);
  return NextResponse.json({ keys: s ? await listApiKeys(s) : [] });
}

export async function POST(req: Request) {
  if (rateLimited(`keys:${clientIp(req)}`, 10, 10 * 60_000).limited)
    return NextResponse.json({ error: "Too many keys; try again in a few minutes." }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as { label?: string };
  const s = await session(true);
  const k = await createApiKey({ label: String(b.label ?? "").trim() || "My AI preparer", session: s });
  return NextResponse.json(k, { status: 201 });
}

export async function DELETE(req: Request) {
  const s = await session(false);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!s || !(await revokeApiKey(id, s))) return NextResponse.json({ error: "key not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
