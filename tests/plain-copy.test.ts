// Guardian refusals reach clients/preparers in plain words, with the rule id kept as a tag.
import { describe, it, expect } from "vitest";
import { plainCondition } from "../src/lib/i18n";
import { buildRows } from "../src/lib/rows";
import { MARIA_SEAT_INTAKE, MARIA_VALUES } from "../src/lib/fixtures";

const ctx = { prep: "Luis Pérez", client: "María González" };

describe("plainCondition", () => {
  it("R13 capture refusal → plain sentence + R13 tag", () => {
    const p = plainCondition('R13: no IRS confirmation ("Accepted") on file', ctx);
    expect(p.tag).toBe("R13");
    expect(p.text.en).toBe("Luis can't be paid yet: the IRS hasn't confirmed it received the return.");
    expect(p.text.es).not.toMatch(/R13/);
  });
  it("state conditions are explained, not shown raw", () => {
    expect(plainCondition("state is AUTHORIZED, must be TRANSMITTED", ctx).text.en).toMatch(/hasn't been filed/);
    expect(plainCondition("state is CAPTURED, must be TRANSMITTED", ctx).text.en).toMatch(/already paid/);
    expect(plainCondition("client has not confirmed", ctx).text.en).toBe("María hasn't confirmed the refund yet.");
  });
  it("unknown conditions are never hidden", () => {
    expect(plainCondition("something new", ctx).text.en).toBe("something new");
  });
});

describe("post-filing rows", () => {
  it("refund that arrived in full stays MATCH; short refund is DIFFERENT", () => {
    const v = { ...MARIA_VALUES };
    const ok = buildRows(MARIA_SEAT_INTAKE, { ...v, deposit_received: 772_900 }, [], { snapshot: v });
    expect(ok.find((r) => r.key === "refund")!.status).toBe("MATCH");
    const short = buildRows(MARIA_SEAT_INTAKE, { ...v, deposit_received: 472_900 }, [], { snapshot: v });
    const r = short.find((x) => x.key === "refund")!;
    expect(r.status).toBe("DIFFERENT");
    expect(r.findings[0].message.en).toMatch(/\$3,000\.00 is missing/);
  });
});
