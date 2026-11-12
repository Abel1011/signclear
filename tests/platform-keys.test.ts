import { describe, it, expect, beforeAll, vi } from "vitest";
import crypto from "node:crypto";

vi.hoisted(() => {
  process.env.DATABASE_URL = "file:./platform-keys-test.db";
});
import { useTestDb } from "./platform-helpers";
import { generateKey, hashKey, createApiKey, authenticateKey, revokeApiKey, bearer, listApiKeys } from "../src/lib/platform/keys";
import { db } from "../src/lib/db";

beforeAll(() => useTestDb("platform-keys-test"), 60_000);

describe("API keys", () => {
  it("generates sk_sc_ keys and hashes them with SHA-256", () => {
    const g = generateKey();
    expect(g.key).toMatch(/^sk_sc_[A-Za-z0-9_-]{32}$/);
    expect(g.hash).toBe(crypto.createHash("sha256").update(g.key).digest("hex"));
    expect(hashKey(g.key)).toBe(g.hash);
    expect(g.prefix).toBe(g.key.slice(0, 12));
    expect(generateKey().key).not.toBe(g.key);
  });

  it("stores only the hash, never the key", async () => {
    const k = await createApiKey({ label: "t", session: "s1" });
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: k.id } });
    expect(row.hash).toBe(hashKey(k.key));
    expect(JSON.stringify(row)).not.toContain(k.key);
  });

  it("authenticates valid keys and rejects unknown, malformed and revoked ones", async () => {
    const k = await createApiKey({ label: "t", session: "s2" });
    const ctx = await authenticateKey(k.key);
    expect(ctx).toMatchObject({ keyId: k.id, session: "s2" });
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: k.id } })).lastUsedAt).not.toBeNull();
    expect(await authenticateKey(generateKey().key)).toBeNull();
    expect(await authenticateKey("sk_live_123")).toBeNull();
    expect(await authenticateKey(null)).toBeNull();
    expect(await revokeApiKey(k.id, "other-session")).toBe(false);
    expect(await revokeApiKey(k.id, "s2")).toBe(true);
    expect(await authenticateKey(k.key)).toBeNull();
    expect((await listApiKeys("s2"))[0].revokedAt).not.toBeNull();
  });

  it("parses Bearer and X-API-Key headers", () => {
    expect(bearer(new Headers({ Authorization: "Bearer sk_sc_abc" }))).toBe("sk_sc_abc");
    expect(bearer(new Headers({ authorization: "bearer   sk_sc_abc " }))).toBe("sk_sc_abc");
    expect(bearer(new Headers({ "X-API-Key": "sk_sc_xyz" }))).toBe("sk_sc_xyz");
    expect(bearer(new Headers({ Authorization: "Basic abc" }))).toBeNull();
  });
});
