// SignClear as an MCP server: the Preparer API v1 capabilities as tools for AI preparer agents.
// Every tool calls the same platform service (src/lib/platform/service.ts) → engine + money guardians.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { APP_NAME } from "../brand";
import * as svc from "./service";
import { heavyLimited } from "./ratelimit";

const PAYMENT_RULES = `How you get paid on ${APP_NAME}: (1) the client reviews the return you submit and must approve it; only then does PayPal AUTHORIZE (hold) your fee. (2) You e-file and register the IRS Submission ID. (3) You upload the IRS e-file acknowledgment DOCUMENT your software printed; SignClear reads it and checks it (Accepted, your Submission ID and EFIN, the client, the date) and only then does the money guardian CAPTURE the fee. Without client approval and IRS acceptance the fee cannot be captured, and if the IRS does not accept by the deadline the hold is voided automatically. Guardian refusals are final and returned verbatim; do not try to work around them.`;

export const MCP_INSTRUCTIONS = `${APP_NAME} is the trust layer between a tax preparer (human or AI agent) and the taxpayer. ${PAYMENT_RULES}`;

export const TOOL_DESCRIPTIONS = {
  create_client_case: "Open a case for a taxpayer client. Returns case_id and a private client_link: send it to the client, who answers a short interview (dependents, income, refund bank account) before you can submit the return.",
  submit_return_for_client_review:
    "Submit the draft Form 1040 + unsigned Form 8879 (base64 PDF/PNG/JPEG ≤10 MB) for the client's review. SignClear reads it and compares it with the client's own answers (identity, dependents, credits, refund account, 8879 amounts). IMPORTANT differences block approval; the fee is never authorized for a return the client didn't approve.",
  get_case_status:
    "Get a case's state, client-review findings, payment status (authorized/captured), e-file status, next allowed actions, and what the capture guardian would refuse right now.",
  record_efile_submission:
    "Register the IRS MeF Submission ID after you e-file. Only allowed once the client approved the return (state AUTHORIZED). The ID must start with your EFIN and carry the current processing year.",
  upload_irs_acknowledgment:
    "Upload the IRS e-file acknowledgment report (base64 PDF/PNG/JPEG ≤10 MB) for the registered Submission ID. There is no status parameter: SignClear reads the document and code verifies status Accepted, the Submission ID, your EFIN, the tax year, the taxpayer and the date. Only a verified acceptance before the deadline lets the money guardian (R13) capture your fee; this call triggers that capture. A verified Rejected acknowledgment lets you retransmit and register a new Submission ID.",
  request_fee_capture: `Ask the money guardian to capture your authorized fee. ${PAYMENT_RULES} Returns ok=false and refused_conditions (verbatim) when it says no.`,
  list_cases: "List the cases created with this API key and their states.",
} as const;

function ok(x: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(x, null, 2) }], structuredContent: x as Record<string, unknown> };
}

function refused(x: { refused_conditions?: string[]; blocked?: string[] } & Record<string, unknown>): CallToolResult {
  const reasons = x.refused_conditions ?? x.blocked ?? [];
  return {
    isError: true,
    content: [
      { type: "text", text: `REFUSED by the ${APP_NAME} money guardian. Conditions not met:\n- ${reasons.join("\n- ")}` },
      { type: "text", text: JSON.stringify(x, null, 2) },
    ],
    structuredContent: x,
  };
}

function fail(e: unknown): CallToolResult {
  const { body } = svc.toErrorBody(e);
  return { isError: true, content: [{ type: "text", text: `${body.error}: ${body.message}${body.issues ? ` ${JSON.stringify(body.issues)}` : ""}` }] };
}

function rateLimitedResult(retryAfterSec: number): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `rate_limited: document reading is limited to 10 calls per 10 minutes per API key; retry in ${retryAfterSec}s.` }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const r = (await fn()) as { ok?: boolean; refused_conditions?: string[]; blocked?: string[] } & Record<string, unknown>;
    return r && r.ok === false ? refused(r) : ok(r);
  } catch (e) {
    return fail(e);
  }
}

export function createMcpServer(ctx: svc.Ctx, hooks: { onReturnSubmitted?: (caseId: string) => void } = {}) {
  const server = new McpServer({ name: "signclear", version: "1.0.0" }, { instructions: MCP_INSTRUCTIONS });
  const c = { ...ctx, actor: ctx.actor ?? "mcp" } as svc.Ctx;
  // Same "heavy" budget as API v1 document reads (shared bucket per key). The in-process Arena is limited per IP at /arena/run.
  const heavy = (fn: () => Promise<CallToolResult>) => {
    if (c.actor === "arena") return fn();
    const rl = heavyLimited(c.keyId);
    return rl.limited ? Promise.resolve(rateLimitedResult(rl.retryAfterSec)) : fn();
  };
  server.registerTool(
    "create_client_case",
    { title: "Create client case", description: TOOL_DESCRIPTIONS.create_client_case, inputSchema: svc.CreateCaseInput.shape },
    (args) => run(() => svc.createClientCase(c, args)),
  );
  server.registerTool(
    "submit_return_for_client_review",
    { title: "Submit return for client review", description: TOOL_DESCRIPTIONS.submit_return_for_client_review, inputSchema: svc.SubmitReturnInput.shape },
    (args) =>
      heavy(() =>
        run(async () => {
          const r = await svc.submitReturn(c, args);
          hooks.onReturnSubmitted?.(r.case_id);
          return r;
        }),
      ),
  );
  server.registerTool(
    "get_case_status",
    { title: "Get case status", description: TOOL_DESCRIPTIONS.get_case_status, inputSchema: svc.CaseIdInput.shape, annotations: { readOnlyHint: true } },
    (args) => run(() => svc.getCaseStatus(c, args)),
  );
  server.registerTool(
    "record_efile_submission",
    { title: "Record e-file submission", description: TOOL_DESCRIPTIONS.record_efile_submission, inputSchema: svc.EfileInput.shape },
    (args) => run(() => svc.recordEfileSubmission(c, args)),
  );
  server.registerTool(
    "upload_irs_acknowledgment",
    { title: "Upload IRS acknowledgment", description: TOOL_DESCRIPTIONS.upload_irs_acknowledgment, inputSchema: svc.AckInput.shape },
    (args) => heavy(() => run(() => svc.uploadIrsAcknowledgment(c, args))),
  );
  server.registerTool(
    "request_fee_capture",
    { title: "Request fee capture", description: TOOL_DESCRIPTIONS.request_fee_capture, inputSchema: svc.CaseIdInput.shape },
    (args) => run(() => svc.requestFeeCapture(c, args)),
  );
  server.registerTool(
    "list_cases",
    { title: "List cases", description: TOOL_DESCRIPTIONS.list_cases, annotations: { readOnlyHint: true } },
    () => run(() => svc.listCases(c)),
  );
  return server;
}
