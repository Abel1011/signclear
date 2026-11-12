// Ghost-Preparer Radar: cross-case analysis over a population of returns. Single cases can look
// innocent; patterns across clients (one refund account for many clients, the same unrequested credit
// again and again, abnormal EITC rates, blank preparer sections) identify the dishonest preparer.
// Deterministic and explainable: every point of the score comes with a reason.
import type { Intake, Values } from "./rules";
import { preFilingRules } from "./rules"; // already includes rules-extra X1–X3 (do not apply them twice)

export type RadarCase = {
  caseKey: string;
  preparerKey: string; // PTIN registered with SignClear
  preparerName?: string;
  clientName: string;
  clientAcct: string; // refund account the client gave us
  returnAcct?: string; // refund account printed on the return
  eitc: number; // cents
  claimsUnmentioned: string[]; // patterns e.g. "fuel_credit", "aotc", "schedule_c", "extra_dependent", "eitc_over", "ctc_over"
  preparerSectionBad: boolean; // blank / self-prepared / PTIN mismatch
  blocked: boolean; // rules produced an IMPORTANT finding
};

export type RadarReason = { code: string; points: number; text: string; cases: string[] };
export type RadarPreparer = {
  preparerKey: string;
  preparerName: string;
  cases: number;
  score: number;
  level: "HIGH" | "WATCH" | "LOW";
  hold: boolean;
  eitcRate: number;
  blockedRate: number;
  reasons: RadarReason[];
};
export type RadarLink = { preparerKey: string; account: string; cases: string[]; clients: number; shared: boolean };
export type RadarResult = { preparers: RadarPreparer[]; links: RadarLink[]; population: { cases: number; eitcRate: number } };

export const HOLD_THRESHOLD = 60;
export const WATCH_THRESHOLD = 30;

/** Completes the sentence "N clients have returns with …". */
const PATTERN_TEXT: Record<string, string> = {
  fuel_credit: "a fuel tax credit (Form 4136) they never mentioned",
  aotc: "an education credit they never mentioned",
  schedule_c: "a Schedule C business they never mentioned, or one that doesn't match what they told us",
  extra_dependent: "more dependents than they told us about",
  eitc_over: "an earned income credit above the IRS table for their children and income",
  ctc_over: "a child tax credit for children who don't qualify",
};

/** Builds a radar case from one return: what the client told us + typed values read from the return. */
export function toRadarCase(x: { caseKey: string; preparerKey: string; preparerName?: string; intake: Intake; values: Values }): RadarCase {
  const { intake, values: v } = x;
  const f = preFilingRules(intake, v, x.preparerKey);
  const has = (rule: string, row?: string) => f.some((y) => y.rule === rule && (!row || y.rowKey === row));
  const claims: string[] = [];
  if ((v.fuel_credit_4136 ?? 0) > 0) claims.push("fuel_credit");
  if ((v.aotc ?? 0) > 0 && !intake.expenses.includes("education")) claims.push("aotc");
  if (has("R4") || has("X3")) claims.push("schedule_c");
  if (f.some((y) => y.rule === "R5" && y.severity === "IMPORTANT")) claims.push("extra_dependent");
  if (has("X1")) claims.push("eitc_over");
  if (has("X2") || has("R6", "ctc")) claims.push("ctc_over");
  return {
    caseKey: x.caseKey,
    preparerKey: x.preparerKey,
    preparerName: x.preparerName,
    clientName: intake.name,
    clientAcct: intake.refundAcctLast4,
    returnAcct: v.refund_acct_last4,
    eitc: v.eitc ?? 0,
    claimsUnmentioned: claims,
    preparerSectionBad: has("R1") || has("R2"),
    blocked: f.some((y) => y.severity === "IMPORTANT"),
  };
}

export function scoreRadar(cases: RadarCase[]): RadarResult {
  const popEitc = cases.length ? cases.filter((c) => c.eitc > 0).length / cases.length : 0;
  // Accounts that receive refunds which are NOT the client's own account
  const foreign = cases.filter((c) => c.returnAcct && c.returnAcct !== c.clientAcct);
  const byAcct = new Map<string, RadarCase[]>();
  for (const c of foreign) byAcct.set(c.returnAcct!, [...(byAcct.get(c.returnAcct!) ?? []), c]);
  const links: RadarLink[] = [];
  for (const [account, cs] of byAcct) {
    const clients = new Set(cs.map((c) => c.clientName)).size;
    const byPrep = new Map<string, string[]>();
    for (const c of cs) byPrep.set(c.preparerKey, [...(byPrep.get(c.preparerKey) ?? []), c.caseKey]);
    for (const [preparerKey, keys] of byPrep) links.push({ preparerKey, account, cases: keys, clients, shared: clients >= 2 });
  }

  const preps = new Map<string, RadarCase[]>();
  for (const c of cases) preps.set(c.preparerKey, [...(preps.get(c.preparerKey) ?? []), c]);
  const out: RadarPreparer[] = [];
  for (const [key, cs] of preps) {
    const reasons: RadarReason[] = [];
    // 1. Shared foreign refund account
    for (const l of links.filter((l) => l.preparerKey === key)) {
      if (l.shared) {
        const others = [...new Set(links.filter((o) => o.account === l.account && o.preparerKey !== key).map((o) => o.preparerKey))];
        reasons.push({
          code: "SHARED_ACCOUNT",
          points: Math.min(60, 35 + 10 * (l.cases.length - 1)),
          text: `Refund account ****${l.account} receives refunds of ${l.clients} different clients${others.length ? ` (also via preparer ${others.join(", ")})` : ""}; none of them gave it as their own.`,
          cases: l.cases,
        });
      } else
        reasons.push({ code: "FOREIGN_ACCOUNT", points: Math.min(20, 10 * l.cases.length), text: `Refund routed to ****${l.account}, not the client's account.`, cases: l.cases });
    }
    // 2. Same unrequested credit / pattern across clients
    const pat = new Map<string, string[]>();
    for (const c of cs) for (const p of c.claimsUnmentioned) pat.set(p, [...(pat.get(p) ?? []), c.caseKey]);
    for (const [p, keys] of pat)
      if (keys.length >= 2) reasons.push({ code: "REPEATED_PATTERN", points: Math.min(30, 15 + 5 * (keys.length - 2)), text: `${keys.length} of this preparer's clients have returns with ${PATTERN_TEXT[p] ?? p}.`, cases: keys });
      else reasons.push({ code: "PATTERN_ONCE", points: 5, text: `One client has a return with ${PATTERN_TEXT[p] ?? p}.`, cases: keys });
    // 3. Abnormal EITC rate
    const eitcRate = cs.filter((c) => c.eitc > 0).length / cs.length;
    if (cs.length >= 3 && popEitc > 0 && eitcRate > popEitc * 1.25) {
      const pts = Math.min(15, Math.round((eitcRate / popEitc - 1) * 20));
      if (pts > 0) reasons.push({ code: "EITC_RATE", points: pts, text: `${Math.round(eitcRate * 100)}% of this preparer's returns claim EITC vs ${Math.round(popEitc * 100)}% across the population.`, cases: cs.filter((c) => c.eitc > 0).map((c) => c.caseKey) });
    }
    // 4. Preparer section integrity (ghost preparer / PTIN)
    const ghost = cs.filter((c) => c.preparerSectionBad);
    if (ghost.length) reasons.push({ code: "GHOST_SECTION", points: Math.min(30, 15 * ghost.length), text: `${ghost.length} return(s) with a blank/self-prepared preparer section or a PTIN that isn't this preparer's.`, cases: ghost.map((c) => c.caseKey) });
    // 5. Share of the preparer's returns that the client-side rules had to block
    const blocked = cs.filter((c) => c.blocked);
    const blockedRate = blocked.length / cs.length;
    if (cs.length >= 2 && blockedRate >= 0.25) reasons.push({ code: "BLOCK_RATE", points: Math.round(30 * blockedRate), text: `${blocked.length} of ${cs.length} returns had to be stopped before the client approved.`, cases: blocked.map((c) => c.caseKey) });

    const score = Math.min(100, reasons.reduce((a, r) => a + r.points, 0));
    out.push({
      preparerKey: key,
      preparerName: cs[0].preparerName ?? key,
      cases: cs.length,
      score,
      level: score >= HOLD_THRESHOLD ? "HIGH" : score >= WATCH_THRESHOLD ? "WATCH" : "LOW",
      hold: score >= HOLD_THRESHOLD,
      eitcRate,
      blockedRate,
      reasons: reasons.sort((a, b) => b.points - a.points),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return { preparers: out, links, population: { cases: cases.length, eitcRate: popEitc } };
}

export type RadarFlags = { preparerKey: string; score: number; level: RadarPreparer["level"]; hold: boolean; reasons: string[] };

/** For the money guardian: should captures for this preparer be held for review?
 *  `population` = the returns to analyze (lab corpus, or radarPopulationFromDb()). */
export function radarFlagsForPreparer(preparerKey: string, population: RadarCase[]): RadarFlags {
  const p = scoreRadar(population).preparers.find((x) => x.preparerKey === preparerKey);
  if (!p) return { preparerKey, score: 0, level: "LOW", hold: false, reasons: [] };
  return { preparerKey, score: p.score, level: p.level, hold: p.hold, reasons: p.reasons.map((r) => `${r.code} +${r.points}: ${r.text}`) };
}

/** Production population: every case with an intake and a read draft return (keyed by preparer PTIN). */
/** Live population. `demoSession` scopes it to one sandbox desk so visitors' sample cases don't pollute each other. */
export async function radarPopulationFromDb(demoSession?: string | null): Promise<RadarCase[]> {
  const { db } = await import("./db");
  const { toValues } = await import("./reader");
  const cs = await db.case.findMany({ where: { intake: { isNot: null }, ...(demoSession ? { demoSession } : {}) }, include: { intake: true, preparer: true, values: { where: { docKind: "DRAFT_1040" } } } });
  return cs
    .filter((c) => c.values.length && c.intake)
    .map((c) => toRadarCase({ caseKey: c.id, preparerKey: c.preparer.ptin, preparerName: c.preparer.name, intake: JSON.parse(c.intake!.data) as Intake, values: toValues(c.values) }));
}
