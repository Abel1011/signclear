// Records one Agent Arena run (both sides) per scenario, so /arena shows them instantly.
// Calls Claude (AGENT_MODEL) and the PayPal SANDBOX (authorize/capture on the SignClear side only).
// Run:  node --use-system-ca --env-file=.env --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/arena/record.mts [honest|malicious|impatient|forged ...]
import { runBatch } from "../../src/lib/arena/runner.ts";
import { verdictLine, type ScenarioId } from "../../src/lib/arena/scenarios.ts";
import { db } from "../../src/lib/db.ts";

const all: ScenarioId[] = ["honest", "malicious", "impatient", "forged"];
const pick = process.argv.slice(2).filter((a): a is ScenarioId => (all as string[]).includes(a));
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (use --env-file=.env.local)");
  process.exit(1);
}

for (const scenario of pick.length ? pick : all) {
  const t0 = Date.now();
  console.log(`\n=== ${scenario} ===`);
  const r = await runBatch(scenario, (side, s) => {
    const line = s.kind === "call" ? `→ ${s.tool}` : s.kind === "result" ? `  ${s.ok ? "ok" : "ERR"} ${s.tool}${s.refused ? ` refused: ${s.refused.join(" | ")}` : ""}` : s.kind === "world" ? `  [${s.actor}] ${s.text.split("\n")[0]}` : s.kind === "error" ? `  !! ${s.text}` : null;
    if (line) console.log(`${side === "naive" ? "L" : "R"} ${line}`);
  });
  console.log(`naive:     ${r.naive.outcome.headline}`);
  console.log(`signclear: ${r.signclear.outcome.headline}`);
  console.log(verdictLine(r.naive.outcome, r.signclear.outcome));
  console.log(`(${Math.round((Date.now() - t0) / 1000)}s, batch ${r.batch})`);
}
await db.$disconnect();
