// MCP server: tool listing, guardian refusals returned verbatim, and the Streamable HTTP route with API-key auth.
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "file:./platform-mcp-test.db";
});
vi.mock("../src/lib/paypal", async () => {
  const h = await import("./platform-helpers");
  const actual = await vi.importActual<typeof import("../src/lib/paypal")>("../src/lib/paypal");
  return { paypal: h.paypalMock, authFromOrder: actual.authFromOrder };
});
vi.mock("../src/lib/agent", () => ({ runAgent: vi.fn(async () => {}) }));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: () => {} };
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { useTestDb, paypalMock } from "./platform-helpers";
import { createApiKey, authenticateKey } from "../src/lib/platform/keys";
import { createMcpServer } from "../src/lib/platform/mcp";
import * as route from "../src/app/api/mcp/route";

const TOOLS = ["create_client_case", "submit_return_for_client_review", "get_case_status", "record_efile_submission", "upload_irs_acknowledgment", "request_fee_capture"];
let KEY = "";
let client: Client;

beforeAll(async () => {
  useTestDb("platform-mcp-test");
  KEY = (await createApiKey({ label: "mcp", session: "desk-m" })).key;
  const ctx = (await authenticateKey(KEY))!;
  const server = createMcpServer({ ...ctx, baseUrl: "http://localhost:3101" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
}, 60_000);

const text = (r: unknown) => ((r as { content: { type: string; text: string }[] }).content ?? []).map((c) => c.text).join("\n");

describe("SignClear MCP server", () => {
  it("lists the preparer tools with descriptions and input schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(TOOLS));
    for (const t of tools.filter((x) => TOOLS.includes(x.name))) expect(t.description!.length).toBeGreaterThan(40);
    const create = tools.find((t) => t.name === "create_client_case")!;
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(["client_name", "fee_usd"]));
    expect(tools.find((t) => t.name === "request_fee_capture")!.description).toMatch(/client approval and IRS acceptance/);
  });

  it("creates a case and returns the guardian's refusal verbatim on an early capture", async () => {
    const created = await client.callTool({ name: "create_client_case", arguments: { client_name: "María González", language: "es", fee_usd: 250 } });
    expect(created.isError).toBeFalsy();
    const caseId = (created.structuredContent as { case_id: string }).case_id;
    const r = await client.callTool({ name: "request_fee_capture", arguments: { case_id: caseId } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/REFUSED by the SignClear money guardian/);
    expect(text(r)).toContain('R13: no IRS confirmation ("Accepted") on file');
    expect(text(r)).toContain("state is CASE_CREATED, must be TRANSMITTED");
    expect(paypalMock.capture).not.toHaveBeenCalled();
    const st = await client.callTool({ name: "get_case_status", arguments: { case_id: caseId } });
    expect((st.structuredContent as { capture_guardian: { would_allow: boolean } }).capture_guardian.would_allow).toBe(false);
  });

  it("upload_irs_acknowledgment takes a document, not a self-declared status", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "upload_irs_acknowledgment")!;
    const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).not.toContain("status");
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["case_id", "document_base64"]));
    const created = await client.callTool({ name: "create_client_case", arguments: { client_name: "Eva Soto", fee_usd: 100 } });
    const caseId = (created.structuredContent as { case_id: string }).case_id;
    const r = await client.callTool({ name: "upload_irs_acknowledgment", arguments: { case_id: caseId, status: "Accepted" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/invalid|document_base64/i);
    expect(paypalMock.capture).not.toHaveBeenCalled();
  });

  it("document tools use the same heavy budget as API v1 document reads", async () => {
    const { resetRateLimits } = await import("../src/lib/platform/ratelimit");
    resetRateLimits();
    let last = "";
    for (let i = 0; i < 11; i++) last = text(await client.callTool({ name: "upload_irs_acknowledgment", arguments: { case_id: "nope", document_base64: "x".repeat(20) } }));
    expect(last).toMatch(/rate_limited/);
    const sub = await client.callTool({ name: "submit_return_for_client_review", arguments: { case_id: "nope", document_base64: "x".repeat(20) } });
    expect(text(sub)).toMatch(/rate_limited/);
    resetRateLimits();
  });

  it("returns state errors as tool errors", async () => {
    const created = await client.callTool({ name: "create_client_case", arguments: { client_name: "Ana Ruiz", fee_usd: 100 } });
    const caseId = (created.structuredContent as { case_id: string }).case_id;
    const r = await client.callTool({ name: "record_efile_submission", arguments: { case_id: caseId, submission_id: "12345620260451234567" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/transmission_refused: cannot file in state CASE_CREATED/);
  });

  it("serves Streamable HTTP at /api/mcp with API-key auth", async () => {
    const rpc = (key: string | null) =>
      new Request("http://localhost:3101/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    expect((await route.POST(rpc(null))).status).toBe(401);
    const res = await route.POST(rpc(KEY));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(j.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(TOOLS));
  });
});
