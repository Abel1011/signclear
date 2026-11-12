// Per-preparer API keys for the Preparer API v1 and the MCP server.
// Format: sk_sc_<32 base64url chars>. Only the SHA-256 hash is stored; the full key is shown once.
import crypto from "node:crypto";
import { db } from "../db";
import { getPreparer } from "../engine";

export const KEY_PREFIX = "sk_sc_";
const KEY_RE = /^sk_sc_[A-Za-z0-9_-]{32}$/;

export type KeyContext = { keyId: string; preparerId: string; session: string | null; prefix: string };

export function hashKey(key: string) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateKey() {
  const key = KEY_PREFIX + crypto.randomBytes(24).toString("base64url");
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) };
}

/** Creates a key for the (sandbox) preparer. Returns the plaintext key ONCE. */
export async function createApiKey(opts: { label: string; session?: string | null; preparerId?: string }) {
  const preparerId = opts.preparerId ?? (await getPreparer()).id;
  const g = generateKey();
  const row = await db.apiKey.create({
    data: { preparerId, hash: g.hash, prefix: g.prefix, label: opts.label.slice(0, 60) || "API key", demoSession: opts.session ?? null },
  });
  return { id: row.id, key: g.key, prefix: g.prefix, label: row.label, createdAt: row.createdAt };
}

export async function listApiKeys(session: string) {
  const rows = await db.apiKey.findMany({ where: { demoSession: session }, orderBy: { createdAt: "desc" } });
  return rows.map((k) => ({ id: k.id, prefix: k.prefix, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt }));
}

export async function revokeApiKey(id: string, session: string) {
  const r = await db.apiKey.updateMany({ where: { id, demoSession: session, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count === 1;
}

/** Extracts the bearer key from an Authorization header (or X-API-Key). */
export function bearer(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  const k = m?.[1] ?? headers.get("x-api-key")?.trim() ?? null;
  return k || null;
}

/** Resolves a plaintext key to its context. Constant-time on the hash; revoked keys are rejected. */
export async function authenticateKey(key: string | null): Promise<KeyContext | null> {
  if (!key || !KEY_RE.test(key)) return null;
  const hash = hashKey(key);
  const row = await db.apiKey.findUnique({ where: { hash } });
  if (!row || row.revokedAt) return null;
  if (!crypto.timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hash, "hex"))) return null;
  // Best-effort; at most one write per minute per key.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000)
    await db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { keyId: row.id, preparerId: row.preparerId, session: row.demoSession, prefix: row.prefix };
}

export async function authenticateRequest(req: Request) {
  return authenticateKey(bearer(req.headers));
}
