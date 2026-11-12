import { describe, it, expect } from "vitest";
import { scoreRadar, radarFlagsForPreparer, toRadarCase, HOLD_THRESHOLD, type RadarCase } from "../src/lib/radar";
import { MARIA_INTAKE, MARIA_VALUES } from "../src/lib/fixtures";

const base = (k: string, prep: string, client: string, acct: string, extra: Partial<RadarCase> = {}): RadarCase => ({
  caseKey: k,
  preparerKey: prep,
  clientName: client,
  clientAcct: acct,
  returnAcct: acct,
  eitc: 0,
  claimsUnmentioned: [],
  preparerSectionBad: false,
  blocked: false,
  ...extra,
});

// Tiny population: an honest preparer, a mule-account preparer, a fuel-credit mill sharing the mule.
const pop: RadarCase[] = [
  base("h1", "P_HONEST", "Ana", "1111", { eitc: 300_000 }),
  base("h2", "P_HONEST", "Beto", "2222"),
  base("h3", "P_HONEST", "Caro", "3333"),
  base("m1", "P_MULE", "Dina", "4444", { returnAcct: "9999", blocked: true, eitc: 500_000 }),
  base("m2", "P_MULE", "Eli", "5555", { returnAcct: "9999", blocked: true, eitc: 500_000 }),
  base("m3", "P_MULE", "Fede", "6666", { returnAcct: "9999", blocked: true, eitc: 500_000 }),
  base("f1", "P_FUEL", "Gabi", "7777", { claimsUnmentioned: ["fuel_credit"], blocked: true }),
  base("f2", "P_FUEL", "Hugo", "8888", { claimsUnmentioned: ["fuel_credit"], blocked: true }),
  base("f3", "P_FUEL", "Ines", "1212", { returnAcct: "9999", blocked: true }),
];

describe("ghost-preparer radar", () => {
  const r = scoreRadar(pop);
  const p = (k: string) => r.preparers.find((x) => x.preparerKey === k)!;

  it("ranks the mule-account preparer first and puts it on hold, with reasons", () => {
    expect(r.preparers[0].preparerKey).toBe("P_MULE");
    expect(p("P_MULE").hold).toBe(true);
    expect(p("P_MULE").reasons[0].code).toBe("SHARED_ACCOUNT");
    expect(p("P_MULE").reasons[0].text).toMatch(/\*\*\*\*9999 receives refunds of 4 different clients \(also via preparer P_FUEL\)/);
  });

  it("links a second preparer to the same mule account and flags its repeated credit", () => {
    const codes = p("P_FUEL").reasons.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["SHARED_ACCOUNT", "REPEATED_PATTERN", "BLOCK_RATE"]));
    expect(p("P_FUEL").score).toBeGreaterThanOrEqual(HOLD_THRESHOLD);
    expect(p("P_FUEL").reasons.find((x) => x.code === "REPEATED_PATTERN")!.text).toBe("2 of this preparer's clients have returns with a fuel tax credit (Form 4136) they never mentioned.");
    expect(r.links.filter((l) => l.account === "9999" && l.shared).map((l) => l.preparerKey).sort()).toEqual(["P_FUEL", "P_MULE"]);
  });

  it("leaves the honest preparer alone", () => {
    expect(p("P_HONEST").score).toBe(0);
    expect(radarFlagsForPreparer("P_HONEST", pop)).toMatchObject({ hold: false, level: "LOW" });
    expect(radarFlagsForPreparer("UNKNOWN", pop)).toMatchObject({ hold: false, score: 0 });
    const f = radarFlagsForPreparer("P_MULE", pop);
    expect(f.hold).toBe(true);
    expect(f.reasons[0]).toMatch(/^SHARED_ACCOUNT \+/);
  });

  it("builds a radar case from a real return (María's clean draft has no signals)", () => {
    const c = toRadarCase({ caseKey: "maria", preparerKey: "P01234567", intake: { ...MARIA_INTAKE, dependents: MARIA_INTAKE.dependents.slice(0, 2) }, values: MARIA_VALUES });
    expect(c).toMatchObject({ claimsUnmentioned: [], preparerSectionBad: false, blocked: false, returnAcct: "1234", clientAcct: "1234" });
  });
});
