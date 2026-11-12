// Remote MCP server (Streamable HTTP, stateless JSON mode). Auth: the same per-preparer API key.
//   claude mcp add --transport http signclear https://<host>/api/mcp --header "Authorization: Bearer sk_sc_..."
import { NextResponse, after } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateRequest } from "@/lib/platform/keys";
import { rateLimited } from "@/lib/platform/ratelimit";
import { baseUrl } from "@/lib/platform/http";
import { createMcpServer } from "@/lib/platform/mcp";
import { runAgent } from "@/lib/agent";

export const dynamic = "force-dynamic";

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers });
}

async function handle(req: Request) {
  const key = await authenticateRequest(req);
  if (!key)
    return rpcError(401, -32001, "Missing or invalid API key. Send `Authorization: Bearer sk_sc_...` (create one at /connect).", {
      "WWW-Authenticate": 'Bearer realm="signclear"',
    });
  const rl = rateLimited(`mcp:${key.keyId}`, 120, 60_000);
  if (rl.limited) return rpcError(429, -32002, `Too many requests; retry in ${rl.retryAfterSec}s.`, { "Retry-After": String(rl.retryAfterSec) });
  const server = createMcpServer(
    { ...key, baseUrl: baseUrl(req), actor: "mcp" },
    { onReturnSubmitted: (caseId) => after(() => runAgent(caseId, "review_ready")) },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    after(() => server.close());
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
