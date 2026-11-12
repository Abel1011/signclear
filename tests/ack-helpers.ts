// Test helper: real acknowledgment PDFs (same renderer as the server) + what a faithful reader would transcribe.
import { renderAckPdf, type AckPdfInput } from "../src/lib/ack-pdf";
import type { AckRead } from "../src/lib/reader";

const truths = new Map<string, AckRead>();

export async function ackDoc(o: Partial<AckPdfInput> & { submissionId: string }) {
  const input: AckPdfInput = {
    status: "Accepted",
    efin: "123456",
    ero: "Pérez Tax Prep (Luis Pérez)",
    taxpayerName: "María González",
    ssnLast4: "4821",
    taxYear: Number(o.submissionId.slice(6, 10)) - 1,
    transmittedAt: new Date(),
    ackDate: new Date(),
    ...o,
  };
  const b64 = Buffer.from(await renderAckPdf(input)).toString("base64");
  truths.set(b64, {
    is_efile_acknowledgment: true,
    submission_id: input.submissionId,
    status: input.status,
    efin: input.efin,
    taxpayer_name: input.taxpayerName,
    ssn_last4: input.ssnLast4,
    tax_year: input.taxYear,
    ack_date: input.status === "Pending" ? null : input.ackDate.toISOString().slice(0, 10),
    transmitted_date: input.transmittedAt.toISOString().slice(0, 10),
  });
  return b64;
}

export function ackTruth(b64: string): AckRead {
  const t = truths.get(b64);
  if (!t) throw new Error("unknown test document");
  return t;
}
