// Shared plumbing for the Preparer API v1 route handlers: API-key auth, rate limits, JSON errors.
import { NextResponse } from "next/server";
import { authenticateRequest } from "./keys";
import { rateLimited, heavyLimited } from "./ratelimit";
import { toErrorBody, type Ctx } from "./service";

export function baseUrl(req: Request) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

const UNAUTHORIZED = {
  error: "unauthorized",
  message: "Missing or invalid API key. Send `Authorization: Bearer sk_sc_...` (create one at /connect).",
};

/** Limits: 120 requests/min per key overall; `heavy` routes (document reading) 10 per 10 min per key. */
export async function withKey(req: Request, fn: (ctx: Ctx) => Promise<unknown>, opts: { heavy?: boolean; status?: number } = {}) {
  try {
    const key = await authenticateRequest(req);
    if (!key) return NextResponse.json(UNAUTHORIZED, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="signclear"' } });
    const rl = rateLimited(`v1:${key.keyId}`, 120, 60_000);
    const rl2 = opts.heavy ? heavyLimited(key.keyId) : { limited: false, retryAfterSec: 0 };
    if (rl.limited || rl2.limited) {
      const s = Math.max(rl.retryAfterSec, rl2.retryAfterSec);
      return NextResponse.json({ error: "rate_limited", message: `Too many requests; retry in ${s}s.` }, { status: 429, headers: { "Retry-After": String(s) } });
    }
    const out = await fn({ ...key, baseUrl: baseUrl(req), actor: "api" });
    return NextResponse.json(out, { status: opts.status ?? 200 });
  } catch (e) {
    const { status, body } = toErrorBody(e);
    return NextResponse.json(body, { status });
  }
}

export async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
