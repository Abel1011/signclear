// Renders a (fictitious) IRS e-file acknowledgment report — the PDF a preparer's tax software prints after
// IRS MeF acknowledges a submission. Used for the static samples (scripts/make-ack-samples.mjs), the desk's
// "Use sample acknowledgment" helper and the Agent Arena. Deterministic: same input → same bytes (cache hits).
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

export type AckPdfInput = {
  submissionId: string;
  status: "Accepted" | "Rejected" | "Pending";
  efin: string;
  ero: string;
  taxpayerName: string;
  ssnLast4: string;
  taxYear: number;
  transmittedAt: Date;
  /** Acknowledgment (acceptance/rejection) date. Ignored for Pending. */
  ackDate: Date;
  software?: string;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function renderAckPdf(a: AckPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fixed = new Date(`${ymd(a.ackDate)}T12:00:00Z`);
  pdf.setTitle(`IRS e-file acknowledgment ${a.submissionId}`);
  pdf.setProducer("SignClear sample generator");
  pdf.setCreator(a.software ?? "TaxBot Pro 2026");
  pdf.setCreationDate(fixed);
  pdf.setModificationDate(fixed);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.14, 0.23);
  const soft = rgb(0.4, 0.44, 0.5);
  const p = pdf.addPage([612, 792]);
  p.drawText("SAMPLE — FICTITIOUS — NOT AN IRS RECORD", { x: 110, y: 400, size: 26, font: bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(30) });
  p.drawText(`${a.software ?? "TaxBot Pro 2026"} — IRS e-file Acknowledgment Report`, { x: 40, y: 750, size: 15, font: bold, color: ink });
  p.drawText("Modernized e-File (MeF) acknowledgment as received by the transmitter. Sample for the SignClear demo.", { x: 40, y: 732, size: 9, font, color: soft });
  p.drawLine({ start: { x: 40, y: 724 }, end: { x: 572, y: 724 }, thickness: 1, color: soft });
  const rows: [string, string][] = [
    ["Electronic Return Originator (ERO)", a.ero],
    ["ERO EFIN", a.efin],
    ["Taxpayer", a.taxpayerName],
    ["Taxpayer SSN", `***-**-${a.ssnLast4}`],
    ["Return type / tax year", `Form 1040 · Tax Year ${a.taxYear}`],
    ["Submission ID", a.submissionId],
    ["Transmitted to IRS", ymd(a.transmittedAt)],
    ["Acknowledgment status", a.status.toUpperCase()],
    [a.status === "Rejected" ? "Rejection date" : a.status === "Accepted" ? "Acceptance date" : "Status date", a.status === "Pending" ? "— (not yet acknowledged)" : ymd(a.ackDate)],
  ];
  let y = 698;
  for (const [k, v] of rows) {
    p.drawText(k, { x: 40, y, size: 11, font, color: ink });
    p.drawText(v, { x: 290, y, size: 11, font: bold, color: ink });
    p.drawLine({ start: { x: 40, y: y - 7 }, end: { x: 572, y: y - 7 }, thickness: 0.3, color: rgb(0.85, 0.85, 0.85) });
    y -= 26;
  }
  y -= 10;
  const note =
    a.status === "Accepted"
      ? ["The IRS accepted this return. Keep this acknowledgment with the signed Form 8879 for 3 years."]
      : a.status === "Rejected"
        ? ["Reject code IND-031-04: Primary taxpayer's prior-year AGI or Self-Select PIN does not match IRS records.", "Correct the return and retransmit (a new Submission ID will be assigned)."]
        : ["The IRS has received this submission but has not acknowledged it yet. This is NOT an acceptance."];
  for (const line of note) {
    p.drawText(line, { x: 40, y, size: 9.5, font, color: ink });
    y -= 15;
  }
  return pdf.save({ useObjectStreams: false });
}
