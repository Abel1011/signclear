// Stores a lab run (meta + per-case results) in the LabRun / LabResult tables.
import { PrismaClient } from "@prisma/client";
import type { LabCaseResult } from "../../src/lib/lab/types.ts";

export type RunMeta = { model: string; startedAt: string; finishedAt: string; summary: unknown; corpus?: string; labVersion?: number; [k: string]: unknown };

export async function storeRun(run: RunMeta, results: LabCaseResult[], db = new PrismaClient()) {
  const { model, startedAt, finishedAt, summary, corpus = "dev", labVersion = 1, ...rest } = run;
  const label = [corpus, rest.partial ? "partial" : ""].filter(Boolean).join(" · ");
  const r = await db.labRun.create({
    data: { model, label, corpus, version: labVersion, startedAt: new Date(startedAt), finishedAt: new Date(finishedAt), summary: JSON.stringify({ ...(summary as object), meta: rest }) },
  });
  for (let i = 0; i < results.length; i += 50)
    await db.labResult.createMany({
      data: results.slice(i, i + 50).map((x) => ({
        runId: r.id,
        caseKey: x.caseKey,
        scheme: x.scheme,
        split: x.split,
        condition: x.condition ?? "pdf",
        expected: x.expected,
        detected: x.production.detected,
        rules: JSON.stringify(x.production.rules),
        verdict: x.production.verdict,
        moneyMovedWrongly: x.production.moneyMovedWrongly,
        readerOk: x.readerOk,
        readerTotal: x.readerTotal,
        latencyMs: x.latencyMs,
        tokensIn: x.tokensIn,
        tokensOut: x.tokensOut,
        detail: JSON.stringify({ production: x.production, core: x.core, readerMisses: x.readerMisses, costUsd: x.costUsd, error: x.error, preparerKey: x.preparerKey, baseKey: x.baseKey, values: x.values }),
      })),
    });
  await db.$disconnect();
  return r.id;
}
