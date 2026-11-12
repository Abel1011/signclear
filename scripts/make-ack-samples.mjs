// Generates the fictitious IRS e-file acknowledgment samples in public/samples/ack/ (same renderer the server uses).
// Run: node node_modules/tsx/dist/cli.mjs scripts/make-ack-samples.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { renderAckPdf } from "../src/lib/ack-pdf.ts";

const SID = "123456" + "2026" + "045" + "a1b2c3d"; // EFIN 123456 + processing year + day of year + 7 chars (= the demo fixture)
const base = {
  submissionId: SID,
  status: "Accepted",
  efin: "123456",
  ero: "Pérez Tax Prep (Luis Pérez)",
  taxpayerName: "María González",
  ssnLast4: "4821",
  taxYear: 2025,
  transmittedAt: new Date("2026-02-14T15:00:00Z"),
  ackDate: new Date("2026-02-15T15:00:00Z"),
};

const samples = {
  "maria-ack-ACCEPTED.pdf": base,
  "maria-ack-REJECTED.pdf": { ...base, status: "Rejected" },
  // Another office's acceptance relabeled: EFIN (and so the Submission ID prefix) is not the preparer's.
  "maria-ack-WRONG-EFIN.pdf": { ...base, submissionId: "654321" + SID.slice(6), efin: "654321", ero: "Rapid Refund Center (J. Doe)" },
  // Right Submission ID and EFIN, but the acceptance belongs to another taxpayer.
  "maria-ack-WRONG-TAXPAYER.pdf": { ...base, taxpayerName: "Carlos Ruiz", ssnLast4: "7710" },
};

mkdirSync("public/samples/ack", { recursive: true });
for (const [file, input] of Object.entries(samples)) {
  writeFileSync(`public/samples/ack/${file}`, await renderAckPdf(input));
  console.log("wrote", `public/samples/ack/${file}`);
}
