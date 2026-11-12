// In-memory sliding-window rate limiter (single-instance sandbox deployment).
const buckets = new Map<string, number[]>();

export function rateLimited(key: string, max: number, windowMs: number): { limited: boolean; retryAfterSec: number } {
  const t = Date.now();
  const arr = (buckets.get(key) ?? []).filter((x) => t - x < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000)) };
  }
  arr.push(t);
  buckets.set(key, arr);
  return { limited: false, retryAfterSec: 0 };
}

export function resetRateLimits() {
  buckets.clear();
}

/** Document reading (the quarantined reader) is the expensive part: 10 per 10 min per API key, shared by
 *  API v1 and MCP (submit_return / upload_irs_acknowledgment). */
export const HEAVY = { max: 10, windowMs: 10 * 60_000 };
export function heavyLimited(keyId: string) {
  return rateLimited(`v1heavy:${keyId}`, HEAVY.max, HEAVY.windowMs);
}

/** Client address for rate-limit keys. X-Forwarded-For is client-controlled unless a trusted proxy sets it:
 *  only with TRUST_PROXY=1 is its left-most entry used; otherwise every caller shares the "local" bucket. */
export function clientIp(req: Request) {
  if (!/^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? "")) return "local";
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : "local";
}
