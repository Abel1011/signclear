// Pure checks behind the IRS acknowledgment verification, and rate-limit client keys.
import { describe, it, expect, afterEach } from "vitest";
import { checkAck, sameTaxpayer } from "../src/lib/ack";
import { cleanAck, type AckRead } from "../src/lib/reader";
import { clientIp } from "../src/lib/platform/ratelimit";

const SID = "12345620260451a2b3c4d".slice(0, 0) + "1234562026045a1b2c3d";
const k = { submissionId: SID, efin: "123456", clientName: "María González", last4s: ["4821"], transmittedAt: new Date("2026-02-14T15:00:00Z"), now: new Date("2026-02-20T12:00:00Z") };
const good: AckRead = { is_efile_acknowledgment: true, submission_id: SID, status: "Accepted", efin: "123456", taxpayer_name: "MARIA GONZALEZ", ssn_last4: "4821", tax_year: 2025, ack_date: "2026-02-15", transmitted_date: "2026-02-14" };
const failed = (r: Partial<AckRead>) => checkAck({ ...good, ...r }, k).checks.filter((c) => !c.ok).map((c) => c.id);

describe("checkAck", () => {
  it("accepts a matching acceptance (accents/case don't matter)", () => {
    expect(checkAck(good, k).accepted).toBe(true);
    expect(sameTaxpayer("María L. González", "Maria Gonzalez")).toBe(true);
    expect(sameTaxpayer("Carlos Ruiz", "María González")).toBe(false);
  });
  it("refuses every forged or mismatched variant", () => {
    expect(failed({ status: "Pending" })).toEqual(["status"]);
    expect(failed({ status: "Rejected" })).toEqual(["status"]);
    expect(failed({ submission_id: "1234562026045zzzzzzz" })).toEqual(["submission_id"]);
    expect(failed({ efin: "654321" })).toEqual(["efin"]);
    expect(failed({ submission_id: "6543212026045a1b2c3d", efin: "654321" })).toEqual(["submission_id", "efin"]);
    expect(failed({ taxpayer_name: "Carlos Ruiz", ssn_last4: "7710" })).toEqual(["taxpayer"]);
    expect(failed({ taxpayer_name: "María González", ssn_last4: "7710" })).toEqual(["taxpayer"]); // any printed id must match
    expect(failed({ taxpayer_name: null, ssn_last4: null })).toEqual(["taxpayer"]);
    expect(failed({ tax_year: 2024 })).toEqual(["tax_year"]);
    expect(failed({ ack_date: "2026-02-13" })).toEqual(["date"]); // before transmission
    expect(failed({ ack_date: "2026-03-01" })).toEqual(["date"]); // in the future
    expect(failed({ is_efile_acknowledgment: false })).toEqual(["document"]);
  });
  it("identity checks pass for a genuine rejection (so it can be retransmitted)", () => {
    const r = checkAck({ ...good, status: "Rejected" }, k);
    expect(r.identityOk).toBe(true);
    expect(r.accepted).toBe(false);
  });
  it("cleans the reader's strings in code", () => {
    const c = cleanAck({ ...good, submission_id: "1234 5620-26045A1B2C3D", efin: "EFIN: 123456", ack_date: "Feb 15 2026", status: "Approved" as never });
    expect(c.submission_id).toBe(SID);
    expect(c.efin).toBe("123456");
    expect(c.ack_date).toBeNull();
    expect(c.status).toBe("Unknown");
  });
});

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });
  const r = (xff: string) => new Request("http://x/", { headers: { "x-forwarded-for": xff } });
  it("ignores X-Forwarded-For unless TRUST_PROXY is set", () => {
    expect(clientIp(r("1.2.3.4"))).toBe("local");
    process.env.TRUST_PROXY = "1";
    expect(clientIp(r("1.2.3.4, 10.0.0.1"))).toBe("1.2.3.4");
    expect(clientIp(r("<script>"))).toBe("local");
  });
});
