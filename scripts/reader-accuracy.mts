// Runs the quarantined reader live on the sample PDF and compares with the known truth.
// Run: node --use-system-ca --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/reader-accuracy.ts
import { readFileSync, writeFileSync } from "node:fs";
import { readDocumentLive, toValues, accuracy } from "../src/lib/reader.ts";
import { MARIA_VALUES } from "../src/lib/fixtures.ts";

const base64 = readFileSync("public/samples/maria-1040-TY2025-SAMPLE.pdf").toString("base64");
const r = await readDocumentLive({ base64, mediaType: "application/pdf" });
const v = toValues(r.rows);
const truth = { ...MARIA_VALUES } as Record<string, unknown>;
delete truth.sums_ok; // computed by code, not read
const acc = accuracy(v, truth as never);
const misses = Object.keys(truth).filter((k) => JSON.stringify((v as Record<string, unknown>)[k]) !== JSON.stringify(truth[k]));
const report = { model: r.model, latencyMs: r.latencyMs, usage: r.usage, accuracy: acc, misses: misses.map((k) => ({ k, read: (v as Record<string, unknown>)[k], truth: truth[k] })) };
writeFileSync("reader-accuracy.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ model: r.model, latencyMs: r.latencyMs, accuracy: acc, misses: report.misses }, null, 1));
