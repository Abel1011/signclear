// Re-imports stored Fraud Lab runs (data/lab/results-<model>-<corpus>.json) into a fresh DB (e.g. after merge/deploy).
// Run: npx prisma migrate deploy && node node_modules/tsx/dist/cli.mjs scripts/lab/import.mts
// Idempotent: skips runs already present (same model + startedAt). Oracle runs are not imported.
import { readFileSync, readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { storeRun, type RunMeta } from "./store.mts";
import type { LabCaseResult } from "../../src/lib/lab/types.ts";

const db = new PrismaClient();
const files = readdirSync("data/lab").filter((f) => /^results-.*\.json$/.test(f) && !f.includes("oracle"));
for (const f of files) {
  const j = JSON.parse(readFileSync(`data/lab/${f}`, "utf8")) as { run: RunMeta; results: LabCaseResult[] };
  if (j.run.labVersion !== 2) {
    console.log(`skip ${f} (pre-v2 semantics)`);
    continue;
  }
  const exists = await db.labRun.findFirst({ where: { model: j.run.model, startedAt: new Date(j.run.startedAt) } });
  if (exists) {
    console.log(`skip ${f} (already imported as ${exists.id})`);
    continue;
  }
  const id = await storeRun(j.run, j.results, new PrismaClient());
  console.log(`imported ${f} -> LabRun ${id} (${j.results.length} cases)`);
}
await db.$disconnect();
