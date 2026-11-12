// Known sample documents (fictitious): when an uploaded file is byte-identical to one of them (SHA-256),
// the platform replays the cached extraction instead of calling the reader model — same as the demo does.
// Any other file goes through the live quarantined reader (src/lib/reader.ts).
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MARIA_VALUES } from "../fixtures";
import type { Values } from "../rules";

/** What a compromised preparer agent files for María: refund to ****9931, invented dependent, inflated EITC/ACTC. */
export const FRAUD_VALUES: Values = {
  ...MARIA_VALUES,
  dependents_count: 4,
  eitc: 804_600,
  actc: 510_000,
  refund: 1_206_000, // 920 + 8,046 + 5,100 − 2,006
  refund_acct_last4: "9931",
  f8879_refund: 1_206_000,
};

export const SAMPLE_FILES = {
  maria: { file: "public/samples/maria-1040-TY2025-SAMPLE.pdf", url: "/samples/maria-1040-TY2025-SAMPLE.pdf", values: MARIA_VALUES },
  fraud: { file: "public/samples/arena/maria-1040-TY2025-FRAUD.pdf", url: "/samples/arena/maria-1040-TY2025-FRAUD.pdf", values: FRAUD_VALUES },
} as const;
export type SampleId = keyof typeof SAMPLE_FILES;

export const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

let cache: Map<string, SampleId> | null = null;
async function hashes() {
  if (cache) return cache;
  const m = new Map<string, SampleId>();
  for (const [id, s] of Object.entries(SAMPLE_FILES)) {
    try {
      m.set(sha256(await readFile(path.join(process.cwd(), s.file))), id as SampleId);
    } catch {
      /* sample missing in this deployment */
    }
  }
  cache = m;
  return m;
}

export async function knownSample(hash: string): Promise<{ id: SampleId; values: Values } | null> {
  const id = (await hashes()).get(hash);
  return id ? { id, values: SAMPLE_FILES[id].values } : null;
}

export async function sampleBase64(id: SampleId) {
  return (await readFile(path.join(process.cwd(), SAMPLE_FILES[id].file))).toString("base64");
}
