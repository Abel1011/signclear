// Client-safe: JSON fetch with a timeout and a couple of retries for network hiccups ("Failed to fetch") and 502–504.
// Only use it for requests that are safe to repeat (idempotent steps, or creating a fresh sample case).

export const FRIENDLY_NETWORK = "We couldn't reach the SignClear server (a network hiccup). Please try again — it's safe to click again.";
export const FRIENDLY_TIMEOUT = "The server is taking longer than usual. Please try again in a moment.";

export type JsonResult<T> = { ok: boolean; status: number; json: T };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJsonRetry<T = Record<string, unknown>>(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retries?: number; backoffMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<JsonResult<T>> {
  const { timeoutMs = 45_000, retries = 2, backoffMs = 800 } = opts;
  const f = opts.fetchImpl ?? fetch;
  let last: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(backoffMs * attempt);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(url, { ...init, signal: ctl.signal });
      if ([502, 503, 504].includes(r.status) && attempt < retries) {
        last = new Error(`HTTP ${r.status}`);
        continue;
      }
      const json = (await r.json().catch(() => ({}))) as T;
      return { ok: r.ok, status: r.status, json };
    } catch (e) {
      last = e;
    } finally {
      clearTimeout(timer);
    }
  }
  const aborted = (last as { name?: string } | null)?.name === "AbortError";
  throw new Error(aborted ? FRIENDLY_TIMEOUT : FRIENDLY_NETWORK);
}
