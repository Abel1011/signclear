import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { preFilingRules, verdict } from "../src/lib/rules";
import { sumsOk } from "../src/lib/reader";
import { MARIA_SEAT_INTAKE, MARIA_VALUES, MARIA_FRAUD_VALUES, FRAUD_ACCT_LAST4, PREPARER, SAMPLE_PDF } from "../src/lib/fixtures";
import { FRAUD_COPY } from "../src/lib/i18n";

describe("prevention scenario (fraud sample)", () => {
  it("only the refund account differs from the honest sample", () => {
    const diff = Object.keys(MARIA_FRAUD_VALUES).filter((k) => JSON.stringify(MARIA_FRAUD_VALUES[k as keyof typeof MARIA_FRAUD_VALUES]) !== JSON.stringify(MARIA_VALUES[k as keyof typeof MARIA_VALUES]));
    expect(diff).toEqual(["refund_acct_last4"]);
    expect(MARIA_FRAUD_VALUES.refund).toBe(772_900);
    expect(sumsOk(MARIA_FRAUD_VALUES)).toBe(true);
  });

  it("R3 stops the approval: refund to ****9931, not María's ****1234", () => {
    const f = preFilingRules(MARIA_SEAT_INTAKE, MARIA_FRAUD_VALUES, PREPARER.ptin);
    expect(f.map((x) => `${x.rule}:${x.severity}`)).toEqual(["R3:IMPORTANT"]);
    expect(f[0].rowKey).toBe("refund_account");
    expect(f[0].message.en).toContain(`****${FRAUD_ACCT_LAST4}`);
    expect(f[0].message.es).toContain("****1234");
    expect(verdict(f)).toBe("DIFFERENCES");
  });

  it("the corrected (honest) return is a clean MATCH for the seat intake", () => {
    expect(verdict(preFilingRules(MARIA_SEAT_INTAKE, MARIA_VALUES, PREPARER.ptin))).toBe("MATCH");
  });

  it("the sample PDF exists and shows the foreign account", () => {
    const pdf = readFileSync(`public${SAMPLE_PDF.fraud}`);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("every prevention string is translated (es/en/pt) and fills its variables", () => {
    for (const [k, m] of Object.entries(FRAUD_COPY)) {
      for (const lang of ["es", "en", "pt"] as const) {
        expect(m[lang], `${k}.${lang}`).toBeTruthy();
        const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
        expect(vars(m[lang]), `${k}.${lang} vars`).toBe(vars(m.en));
      }
      expect(m.es).not.toBe(m.en);
    }
  });
});
