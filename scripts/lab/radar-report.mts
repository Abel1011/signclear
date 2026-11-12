// Prints the radar evaluation for every population (corpus × reader model × document condition, plus the
// ground-truth reference) and the ranking for one of them.
// Run: node node_modules/tsx/dist/cli.mjs scripts/lab/radar-report.mts [unseen|claude-opus-5-5|photo]
import { allPreparers, radarViews } from "../../src/lib/lab/data.ts";

const views = await radarViews();
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
for (const v of views)
  console.log(`${v.id.padEnd(36)} hold precision ${pct(v.eval.precision)} (${v.eval.holdTP}/${v.eval.holdTP + v.eval.holdFP}) · recall ${pct(v.eval.recall)} (${v.eval.holdTP}/${v.eval.bad}) · honest on watch/hold ${v.eval.watchOrHoldFP}/${v.eval.honest} ${v.eval.honestFlagged.join(" ")} ${v.eval.badMissed.length ? "· missed " + v.eval.badMissed.join(" ") : ""}`);
const want = process.argv[2] ?? "unseen|claude-opus-5-5|photo";
const v = views.find((x) => x.id === want) ?? views[0];
const bad = Object.fromEntries(allPreparers().map((p) => [p.key, p.bad]));
console.log(`\n${v.id}`);
for (const p of v.result.preparers) console.log(p.preparerKey, bad[p.preparerKey] ? "BAD   " : "honest", String(p.score).padStart(3), p.level.padEnd(5), `${p.cases} returns`, p.reasons.map((x) => `${x.code}+${x.points}`).join(" "));
process.exit(0);
