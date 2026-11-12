// Test harness: a throwaway SQLite DB + PayPal mocked at the fetch level. Import FIRST in a test file.
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

const file = path.join(os.tmpdir(), `signclear-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = "file:" + file.replace(/\\/g, "/");
process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
process.env.PAYPAL_API_BASE = "https://pp.test";
delete process.env.MULTIPARTY;
delete process.env.PAYPAL_BN_CODE;
execSync("npx prisma db push --skip-generate --accept-data-loss", { env: process.env, stdio: "ignore" });

export type Call = { method: string; path: string; headers: Record<string, string>; body: unknown; form?: FormData };
type Reply = { status: number; body?: unknown; debugId?: string };
type Route = { method: string; re: RegExp; replies: Array<Reply | ((c: Call) => Reply)>; sticky?: boolean };

export function mockPayPal() {
  const routes: Route[] = [];
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    if (u.pathname === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const form = init.body instanceof FormData ? init.body : undefined;
    const body = form ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call: Call = { method, path: u.pathname + u.search, headers, body, form };
    calls.push(call);
    const r = routes.find((x) => x.method === method && x.re.test(u.pathname) && x.replies.length);
    if (!r) return new Response(JSON.stringify({ name: "NOT_MOCKED" }), { status: 599, headers: { "paypal-debug-id": "dbg-unmocked" } });
    const next = r.sticky && r.replies.length === 1 ? r.replies[0] : r.replies.shift()!;
    const rep = typeof next === "function" ? next(call) : next;
    return new Response(rep.body === undefined || rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { "paypal-debug-id": rep.debugId ?? `dbg-${calls.length}` } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    on(method: string, re: RegExp, ...replies: Array<Reply | ((c: Call) => Reply)>) {
      routes.push({ method, re, replies });
      return this;
    },
    always(method: string, re: RegExp, reply: Reply | ((c: Call) => Reply)) {
      routes.push({ method, re, replies: [reply], sticky: true });
      return this;
    },
    reset() {
      routes.length = 0;
      calls.length = 0;
    },
    find(method: string, re: RegExp) {
      return calls.filter((c) => c.method === method && re.test(c.path));
    },
  };
}

export const ppErr = (status: number, issue?: string): Reply => ({ status, body: { name: "ERR", details: issue ? [{ issue }] : [] } });

export async function resetDb() {
  const { db } = await import("../src/lib/db");
  for (const m of ["dispute", "feeLine", "auditEvent", "notification", "chatMessage", "agentRun", "payment", "approvedSnapshot", "finding", "extractedValue", "document", "intake", "webhookEvent", "case", "preparer"] as const)
    await (db[m] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
}

export async function seedCase(opts: { state: string; fee?: number; stateFee?: number; payment?: Record<string, unknown>; lines?: Array<Record<string, unknown>>; extra?: Record<string, unknown>; merchantId?: string }) {
  const { db } = await import("../src/lib/db");
  const p = await db.preparer.create({ data: { name: "Luis Pérez", business: "Pérez Tax Prep", ptin: "P01234567", efin: "123456", paypalMerchantId: opts.merchantId } });
  const now = Date.now();
  const c = await db.case.create({
    data: {
      preparerId: p.id,
      clientName: "María González",
      fee: opts.fee ?? 25_000,
      stateFee: opts.stateFee ?? 0,
      state: opts.state,
      isDemo: true,
      seasonOpen: new Date(now - 7 * 86400_000),
      approvedAt: new Date(now - 86400_000),
      ackDeadline: new Date(now + 4 * 86400_000),
      clientToken: `c-${Math.random().toString(36).slice(2)}`,
      preparerToken: `p-${Math.random().toString(36).slice(2)}`,
      ...(opts.extra ?? {}),
    },
  });
  if (opts.payment)
    await db.payment.create({
      data: { caseId: c.id, orderId: "ORDER1", authorizationId: "AUTH1", status: "AUTHORIZED", amount: opts.fee ?? 25_000, expirationTime: new Date(now + 20 * 86400_000), ...opts.payment },
    });
  for (const l of opts.lines ?? []) await db.feeLine.create({ data: { caseId: c.id, kind: "FEDERAL", amount: 0, ...l } as never });
  return c;
}

/** A TRANSMITTED case whose IRS acceptance is on file (capture guardian passes). */
export const transmitted = { submissionId: "12345620261234abc1234", transmittedAt: new Date(Date.now() - 3600_000), ackReceivedAt: new Date() };
