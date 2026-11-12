// OpenAPI 3.1 description of the Preparer API v1, generated from the same zod schemas the handlers use.
import { z } from "zod";
import { CreateCaseInput, SubmitReturnInput, EfileInput, AckInput } from "./service";
import { APP_NAME } from "../brand";

const schema = (s: z.ZodType, omit: string[] = []) => {
  const j = z.toJSONSchema(s, { io: "input" }) as { properties?: Record<string, unknown>; required?: string[]; $schema?: string };
  delete j.$schema;
  for (const k of omit) {
    delete j.properties?.[k];
    j.required = j.required?.filter((r) => r !== k);
  }
  return j;
};

const err = { $ref: "#/components/schemas/Error" };
const caseIdParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "case_id returned by POST /cases" };
const json = (s: unknown) => ({ content: { "application/json": { schema: s } } });
const errors = {
  "400": { description: "Invalid input", ...json(err) },
  "401": { description: "Missing or invalid API key", ...json(err) },
  "404": { description: "Case not found for this key", ...json(err) },
  "409": { description: "Not allowed in the case's current state", ...json(err) },
  "429": { description: "Rate limited", ...json(err) },
};

export function openapi(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: `${APP_NAME} Preparer API`,
      version: "1.0.0",
      description:
        `${APP_NAME} is the trust layer between any tax preparer — human or AI agent — and the taxpayer. ` +
        "The client reviews the return before signing; PayPal AUTHORIZES the fee on approval, and it is CAPTURED only after the IRS accepts the return " +
        "(guardian R13). Money is decided by deterministic guardians; requests that don't meet their conditions are refused with the reasons. " +
        "The same capabilities are available as MCP tools at /api/mcp. SANDBOX: PayPal sandbox only; there is no IRS connection, so acknowledgments are the documents your software prints, read and verified by SignClear.",
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "sk_sc_…", description: "Per-preparer API key from /connect" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } }, required: ["error", "message"] },
        CreateCase: schema(CreateCaseInput),
        SubmitReturn: schema(SubmitReturnInput, ["case_id"]),
        Efile: schema(EfileInput, ["case_id"]),
        Ack: schema(AckInput, ["case_id"]),
        GuardianResult: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            captured: { type: "boolean" },
            state: { type: "string" },
            refused_conditions: { type: "array", items: { type: "string" }, description: "Verbatim reasons from the money guardian" },
          },
        },
      },
    },
    paths: {
      "/cases": {
        get: { operationId: "listCases", summary: "List this key's cases", responses: { "200": { description: "Cases" }, "401": errors["401"] } },
        post: {
          operationId: "createClientCase",
          summary: "Create a client case",
          description: "Returns the private client link. The client answers a short interview there before you can submit the return. Send an Idempotency-Key header to make retries safe: the same key returns the same case.",
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 } }],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/CreateCase" }) },
          responses: { "201": { description: "Case created (case_id, client_link)" }, "400": errors["400"], "401": errors["401"], "429": errors["429"] },
        },
      },
      "/cases/{id}": {
        get: {
          operationId: "getCaseStatus",
          summary: "Case status",
          description: "State, client-review findings, payment status, e-file status, next allowed actions and the capture guardian's current verdict.",
          parameters: [caseIdParam],
          responses: { "200": { description: "Status" }, "401": errors["401"], "404": errors["404"] },
        },
      },
      "/cases/{id}/return": {
        post: {
          operationId: "submitReturnForClientReview",
          summary: "Submit the draft return for the client's review",
          description: "Base64 PDF/PNG/JPEG ≤10 MB with the draft 1040 and unsigned Form 8879. SignClear reads it and compares it with the client's own answers (refund account, dependents, credits, identity, 8879).",
          parameters: [caseIdParam],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/SubmitReturn" }) },
          responses: { "200": { description: "Review result" }, ...errors, "413": { description: "Too large", ...json(err) }, "415": { description: "Unsupported file", ...json(err) } },
        },
      },
      "/cases/{id}/efile": {
        post: {
          operationId: "recordEfileSubmission",
          summary: "Register the IRS e-file transmission",
          description: "Only after the client approved (state AUTHORIZED). Submission ID must start with your EFIN.",
          parameters: [caseIdParam],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/Efile" }) },
          responses: { "200": { description: "Transmitted" }, ...errors },
        },
      },
      "/cases/{id}/ack": {
        post: {
          operationId: "uploadIrsAcknowledgment",
          summary: "Upload the IRS e-file acknowledgment document",
          description:
            "Base64 PDF/PNG/JPEG ≤10 MB of the acknowledgment report your tax software produced. There is no status field: SignClear reads the document (quarantined reader) and code checks status Accepted, Submission ID = the registered one, EFIN = yours, tax year, taxpayer = the client and acknowledgment date ≥ transmission. Only then does the guardian capture the fee. A verified Rejected acknowledgment keeps the case TRANSMITTED so you can correct, retransmit and register the new Submission ID before the deadline.",
          parameters: [caseIdParam],
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/Ack" }) },
          responses: { "200": { description: "Guardian result", ...json({ $ref: "#/components/schemas/GuardianResult" }) }, ...errors },
        },
      },
      "/cases/{id}/capture": {
        post: {
          operationId: "requestFeeCapture",
          summary: "Request capture of the authorized fee",
          description: "Goes through the money guardian. Without client approval and an IRS acceptance it is refused; refused_conditions lists why.",
          parameters: [caseIdParam],
          responses: { "200": { description: "Guardian result (ok=false when refused)", ...json({ $ref: "#/components/schemas/GuardianResult" }) }, "401": errors["401"], "404": errors["404"] },
        },
      },
    },
  };
}
