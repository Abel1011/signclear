import { describe, it, expect } from "vitest";
import { fraudFacts } from "../src/lib/arena/runner";
import { SAMPLE_FILES } from "../src/lib/platform/samples";

describe("arena fraud numbers", () => {
  it("come from the fraudulent PDF's values and add up", () => {
    const f = fraudFacts();
    const v = SAMPLE_FILES.fraud.values;
    expect(f.filedRefund).toBe(v.refund);
    expect(f.filedRefund).toBe((v.withholding ?? 0) + (v.eitc ?? 0) + (v.actc ?? 0) - (v.total_tax ?? 0));
    expect(f.filedAcct).toBe("9931");
    expect(f.clientAcct).toBe("1234");
    expect(f.inflation).toBe(f.filedRefund - f.correctRefund);
    expect(f.filedDeps).toBeGreaterThan(f.correctDeps);
  });
});
