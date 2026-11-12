// Shared setup for tests/platform-*.test.ts: a throwaway SQLite DB and a mocked PayPal module.
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { vi } from "vitest";

export function useTestDb(name: string) {
  process.env.DATABASE_URL = `file:./${name}.db`;
  // Fresh throwaway file (prisma/<name>.db, git-ignored) every run.
  for (const s of ["", "-journal", "-wal", "-shm"]) rmSync(`prisma/${name}.db${s}`, { force: true });
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: { ...process.env } });
}

let n = 0;
const ok = (body: unknown, status = 201) => ({ ok: true, status, debugId: "test", body, endpoint: "test" });

export const paypalMock = {
  createAuthorizeOrder: vi.fn(async (p: { customId: string }) =>
    ok({
      id: `ORD-${++n}`,
      status: "COMPLETED",
      payer: { name: { given_name: "María", surname: "González" } },
      purchase_units: [{ payments: { authorizations: [{ id: `AUTH-${n}-${p.customId}`, status: "CREATED", expiration_time: new Date(Date.now() + 29 * 864e5).toISOString() }] } }],
    }),
  ),
  authorizeOrder: vi.fn(async () => ok({})),
  getOrder: vi.fn(async () => ok({})),
  capture: vi.fn(async () => ok({ id: `CAP-${++n}`, status: "COMPLETED" })),
  getCapture: vi.fn(async () => ok({ status: "COMPLETED" })),
  void: vi.fn(async () => ok(null, 204)),
  refund: vi.fn(async () => ok({ id: "REF", status: "COMPLETED" })),
  reauthorize: vi.fn(async () => ({ ok: false, status: 422, debugId: null, body: null, endpoint: "test" })),
  getAuthorization: vi.fn(async () => ok({})),
};
