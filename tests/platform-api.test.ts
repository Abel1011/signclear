// Preparer API v1: every endpoint goes through the engine and the money guardians; PayPal is mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.hoisted(() => {
  process.env.DATABASE_URL = "file:./platform-api-test.db";
});
vi.mock("../src/lib/paypal", async () => {
  const h = await import("./platform-helpers");
  const actual = await vi.importActual<typeof import("../src/lib/paypal")>("../src/lib/paypal");
  return { ...actual, paypal: h.paypalMock, authFromOrder: actual.authFromOrder };
});
vi.mock("../src/lib/agent", () => ({ runAgent: vi.fn(async () => {}) }));
// The acknowledgment reader (Claude) is replaced by a transcription of what the test document says.
vi.mock("../src/lib/reader", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/reader")>("../src/lib/reader");
  const { ackTruth } = await import("./ack-helpers");
  return { ...actual, readAcknowledgment: vi.fn(async (f: { base64: string }) => ({ read: ackTruth(f.base64), latencyMs: 1, usage: {}, model: "test" })) };
});
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: () => {} };
});

import { useTestDb, paypalMock } from "./platform-helpers";
import { createApiKey } from "../src/lib/platform/keys";
import { resetRateLimits } from "../src/lib/platform/ratelimit";
import * as engine from "../src/lib/engine";
import * as money from "../src/lib/money";
import { MARIA_INTAKE, PREPARER } from "../src/lib/fixtures";
import { db } from "../src/lib/db";
import { ackDoc } from "./ack-helpers";
import type { AckPdfInput } from "../src/lib/ack-pdf";
import * as cases from "../src/app/api/v1/cases/route";
import * as caseOne from "../src/app/api/v1/cases/[id]/route";
import * as ret from "../src/app/api/v1/cases/[id]/return/route";
import * as efile from "../src/app/api/v1/cases/[id]/efile/route";
import * as ack from "../src/app/api/v1/cases/[id]/ack/route";
import * as cap from "../src/app/api/v1/cases/[id]/capture/route";
import * as oas from "../src/app/api/v1/openapi.json/route";

const MARIA_PDF = readFileSync("public/samples/maria-1040-TY2025-SAMPLE.pdf").toString("base64");
const FRAUD_PDF = readFileSync("public/samples/arena/maria-1040-TY2025-FRAUD.pdf").toString("base64");

let KEY = "";
let OTHER = "";
const req = (method: string, path: string, body?: unknown, key: string | null = KEY) =>
  new Request(`http://localhost:3101/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const sid = () => {
  const d = new Date();
  const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  return `${PREPARER.efin}${d.getFullYear()}${String(doy).padStart(3, "0")}abc1234`;
};

async function newCase(key = KEY) {
  const r = await cases.POST(req("POST", "/cases", { client_name: "María González", language: "es", fee_usd: 250 }, key));
  expect(r.status).toBe(201);
  return (await r.json()) as { case_id: string; client_link: string };
}

beforeAll(async () => {
  useTestDb("platform-api-test");
  KEY = (await createApiKey({ label: "test", session: "desk-a" })).key;
  OTHER = (await createApiKey({ label: "other", session: "desk-b" })).key;
}, 60_000);
beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

describe("Preparer API v1", () => {
  it("rejects requests without a valid key", async () => {
    const r = await cases.GET(req("GET", "/cases", undefined, null));
    expect(r.status).toBe(401);
    expect((await cases.GET(req("GET", "/cases", undefined, "sk_sc_" + "x".repeat(32)))).status).toBe(401);
  });

  it("validates input with zod", async () => {
    const r = await cases.POST(req("POST", "/cases", { client_name: "Al", fee_usd: 5 }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_request");
  });

  it("creates a case with a client link; the case is in the key's desk and invisible to other keys", async () => {
    const c = await newCase();
    expect(c.client_link).toMatch(/^http:\/\/localhost:3101\/c\//);
    const row = await db.case.findUniqueOrThrow({ where: { id: c.case_id } });
    expect(row.demoSession).toBe("desk-a");
    expect((await caseOne.GET(req("GET", `/cases/${c.case_id}`, undefined, OTHER), p(c.case_id))).status).toBe(404);
    const list = await (await cases.GET(req("GET", "/cases"))).json();
    expect(list.cases.some((x: { case_id: string }) => x.case_id === c.case_id)).toBe(true);
  });

  it("refuses a return before the client answered the interview", async () => {
    const c = await newCase();
    const r = await ret.POST(req("POST", `/cases/${c.case_id}/return`, { document_base64: MARIA_PDF }), p(c.case_id));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("client_interview_pending");
  });

  it("rejects files that are not what they claim", async () => {
    const c = await newCase();
    await engine.submitIntake(c.case_id, MARIA_INTAKE, { review: true, other: false });
    const r = await ret.POST(req("POST", `/cases/${c.case_id}/return`, { document_base64: Buffer.from("hello world, not a pdf").toString("base64") }), p(c.case_id));
    expect(r.status).toBe(415);
  });

  it("full honest path: capture is refused until client approval + IRS acceptance, then captured once", async () => {
    const c = await newCase();
    await engine.submitIntake(c.case_id, MARIA_INTAKE, { review: true, other: false });
    const sub = await (await ret.POST(req("POST", `/cases/${c.case_id}/return`, { document_base64: MARIA_PDF, filename: "maria.pdf" }), p(c.case_id))).json();
    expect(sub.state).toBe("CLARIFY");
    expect(sub.review.map((f: { rule: string }) => f.rule)).toEqual(["R5"]);

    // Before approval: guardian refuses, PayPal untouched
    let g = await (await cap.POST(req("POST", `/cases/${c.case_id}/capture`), p(c.case_id))).json();
    expect(g.ok).toBe(false);
    expect(g.refused_conditions.join(" ")).toMatch(/must be TRANSMITTED/);
    expect(g.refused_conditions.join(" ")).toMatch(/R13/);
    expect((await efile.POST(req("POST", `/cases/${c.case_id}/efile`, { submission_id: sid() }), p(c.case_id))).status).toBe(409);

    // Client approves → PayPal AUTHORIZE (mocked)
    await engine.acceptClarifications(c.case_id);
    expect((await money.createOrder(c.case_id, { card: true })).ok).toBe(true);
    let st = await (await caseOne.GET(req("GET", `/cases/${c.case_id}`), p(c.case_id))).json();
    expect(st.state).toBe("AUTHORIZED");
    expect(st.next_allowed_actions).toEqual(["record_efile_submission"]);

    // Bad Submission ID (not our EFIN)
    const bad = await efile.POST(req("POST", `/cases/${c.case_id}/efile`, { submission_id: "999999" + sid().slice(6) }), p(c.case_id));
    expect(bad.status).toBe(409);
    expect((await bad.json()).message).toMatch(/EFIN/);
    expect((await efile.POST(req("POST", `/cases/${c.case_id}/efile`, { submission_id: sid() }), p(c.case_id))).status).toBe(200);

    // Transmitted but no IRS acceptance → refused (R13), PayPal capture not called
    g = await (await cap.POST(req("POST", `/cases/${c.case_id}/capture`), p(c.case_id))).json();
    expect(g.ok).toBe(false);
    expect(g.refused_conditions).toContain('R13: no IRS confirmation ("Accepted") on file');
    expect(paypalMock.capture).not.toHaveBeenCalled();

    // Self-declared status is not accepted any more: the schema has no `status` and requires the document.
    let r0 = await ack.POST(req("POST", `/cases/${c.case_id}/ack`, { status: "Accepted", submission_id: sid() }), p(c.case_id));
    expect(r0.status).toBe(400);
    const doc = (o: Partial<AckPdfInput>) => ackDoc({ submissionId: sid(), ...o });
    r0 = await ack.POST(req("POST", `/cases/${c.case_id}/ack`, { document_base64: await doc({}), status: "Accepted" }), p(c.case_id));
    expect(r0.status).toBe(400);
    const post = async (b64: string) => (await ack.POST(req("POST", `/cases/${c.case_id}/ack`, { document_base64: b64 }), p(c.case_id))).json();

    // Forged acceptances are refused by code (the guardian is never asked)
    const pending = await post(await doc({ status: "Pending" }));
    expect(pending).toMatchObject({ ok: false, verdict: "REFUSED", state: "TRANSMITTED" });
    expect(pending.blocked.join(" ")).toMatch(/status is Pending, not Accepted/);
    const otherSid = await post(await doc({ submissionId: "123456" + "2026001zzzzzzz" }));
    expect(otherSid.blocked.join(" ")).toMatch(/registered/);
    const wrongEfin = await post(await doc({ submissionId: "654321" + sid().slice(6), efin: "654321" }));
    expect(wrongEfin.blocked.join(" ")).toMatch(/not the preparer's EFIN 123456/);
    const wrongWho = await post(await doc({ taxpayerName: "Carlos Ruiz", ssnLast4: "7710" }));
    expect(wrongWho.blocked.join(" ")).toMatch(/not the client María González/);
    const wrongYear = await post(await doc({ taxYear: 2021 }));
    expect(wrongYear.blocked.join(" ")).toMatch(/tax year 2021/);
    const early = await post(await doc({ ackDate: new Date(Date.now() - 5 * 864e5) }));
    expect(early.blocked.join(" ")).toMatch(/not between the transmission/);
    expect(paypalMock.capture).not.toHaveBeenCalled();
    expect((await db.case.findUniqueOrThrow({ where: { id: c.case_id } })).ackReceivedAt).toBeNull();

    resetRateLimits(); // the forgeries above used up this key's document-reading budget
    // A verified IRS rejection: stays TRANSMITTED, "correct and retransmit", a new Submission ID may be registered
    const rej = await post(await doc({ status: "Rejected" }));
    expect(rej).toMatchObject({ ok: false, verdict: "REJECTED_BY_IRS", state: "TRANSMITTED" });
    expect(rej.message).toMatch(/Rejected — correct and retransmit/);
    const sid2 = sid().slice(0, 13) + "zz98765";
    expect((await efile.POST(req("POST", `/cases/${c.case_id}/efile`, { submission_id: sid2 }), p(c.case_id))).status).toBe(200);
    expect((await db.case.findUniqueOrThrow({ where: { id: c.case_id } })).submissionId).toBe(sid2);
    // The old acceptance-for-the-old-SID no longer matches
    expect((await post(await doc({}))).verdict).toBe("REFUSED");
    // Without a rejection, no re-registration
    expect((await efile.POST(req("POST", `/cases/${c.case_id}/efile`, { submission_id: sid().slice(0, 13) + "zz11111" }), p(c.case_id))).status).toBe(409);

    // Accepted, for the registered SID, our EFIN, the client, after transmission → guardian captures
    const a = await post(await doc({ submissionId: sid2 }));
    expect(a).toMatchObject({ ok: true, verdict: "ACCEPTED", state: "CAPTURED", captured: true });
    expect(a.acknowledgment_read).toMatchObject({ status: "Accepted", submission_id: sid2, efin: "123456" });
    expect(paypalMock.capture).toHaveBeenCalledTimes(1);
    const vals = await db.extractedValue.findMany({ where: { caseId: c.case_id, docKind: "IRS_ACK" } });
    expect(Object.fromEntries(vals.map((v) => [v.label, v.value]))).toMatchObject({ ack_status: "Accepted", ack_submission_id: sid2, ack_verified: "true" });
    expect(await db.auditEvent.count({ where: { caseId: c.case_id, action: "irs_ack_verified" } })).toBe(1);
    // Idempotent
    g = await (await cap.POST(req("POST", `/cases/${c.case_id}/capture`), p(c.case_id))).json();
    expect(g).toMatchObject({ ok: true, already: true });
    expect(paypalMock.capture).toHaveBeenCalledTimes(1);
    st = await (await caseOne.GET(req("GET", `/cases/${c.case_id}`), p(c.case_id))).json();
    expect(st.payment).toMatchObject({ captured: true, status: "COMPLETED" });
  });

  it("a diverted/inflated return is flagged and the fee can never be held or captured", async () => {
    const c = await newCase();
    await engine.submitIntake(c.case_id, MARIA_INTAKE, { review: true, other: false });
    const sub = await (await ret.POST(req("POST", `/cases/${c.case_id}/return`, { document_base64: FRAUD_PDF }), p(c.case_id))).json();
    expect(sub.state).toBe("DIFFERENCES");
    const rules = sub.review.map((f: { rule: string; message: string }) => `${f.rule}:${f.message}`).join(" | ");
    expect(rules).toMatch(/R3:.*\*\*\*\*9931/);
    expect(rules).toMatch(/R5:.*4 dependents/);
    expect((await money.createOrder(c.case_id)).ok).toBe(false); // client approval impossible in DIFFERENCES
    const g = await (await cap.POST(req("POST", `/cases/${c.case_id}/capture`), p(c.case_id))).json();
    expect(g.ok).toBe(false);
    expect(g.refused_conditions).toContain("no authorization");
    expect(paypalMock.createAuthorizeOrder).not.toHaveBeenCalled();
    expect(paypalMock.capture).not.toHaveBeenCalled();
  });

  it("Idempotency-Key returns the same case on retry (scoped to the key's desk)", async () => {
    const body = { client_name: "Rosa Díaz", language: "es", fee_usd: 180 };
    const send = (key = KEY, b: unknown = body) =>
      cases.POST(new Request("http://localhost:3101/api/v1/cases", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Idempotency-Key": "retry-123" }, body: JSON.stringify(b) }));
    const a = await (await send()).json();
    const b = await (await send()).json();
    expect(b.case_id).toBe(a.case_id);
    expect(b.idempotent_replay).toBe(true);
    expect(await db.case.count({ where: { clientName: "Rosa Díaz" } })).toBe(1);
    expect((await send(KEY, { ...body, fee_usd: 999 })).status).toBe(422);
    const other = await (await send(OTHER)).json(); // same key string, other desk → its own case
    expect(other.case_id).not.toBe(a.case_id);
  });

  it("document uploads (return + acknowledgment) share the heavy budget", async () => {
    const c = await newCase();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await ack.POST(req("POST", `/cases/${c.case_id}/ack`, { document_base64: Buffer.from("not a pdf, but long enough").toString("base64") }), p(c.case_id))).status;
    expect(last).toBe(429);
    expect((await ret.POST(req("POST", `/cases/${c.case_id}/return`, { document_base64: MARIA_PDF }), p(c.case_id))).status).toBe(429);
  });

  it("rate-limits per key", async () => {
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await cases.GET(req("GET", "/cases"))).status;
    expect(last).toBe(429);
  });

  it("serves an OpenAPI 3.1 document", async () => {
    const j = await (await oas.GET(new Request("http://localhost:3101/api/v1/openapi.json"))).json();
    expect(j.openapi).toBe("3.1.0");
    expect(Object.keys(j.paths)).toEqual(expect.arrayContaining(["/cases", "/cases/{id}", "/cases/{id}/return", "/cases/{id}/efile", "/cases/{id}/ack", "/cases/{id}/capture"]));
    expect(j.components.schemas.CreateCase.required).toContain("client_name");
  });
});
