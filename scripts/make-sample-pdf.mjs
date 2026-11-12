// Generates the fictitious sample return used by the demo (TY2025 layout, real line numbers).
// Run: node scripts/make-sample-pdf.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync, mkdirSync } from "node:fs";

mkdirSync("public/samples", { recursive: true });
for (const [NAME, FILE] of [["María González", "maria-1040-TY2025-SAMPLE.pdf"], ["Carlos Ruiz", "carlos-1040-TY2025-SAMPLE.pdf"]]) {
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const ink = rgb(0.08, 0.14, 0.23);
const soft = rgb(0.4, 0.44, 0.5);

function page(title, rows, extra = () => {}) {
  const p = pdf.addPage([612, 792]);
  p.drawText("SAMPLE — FICTITIOUS — NOT A REAL TAX RETURN", { x: 120, y: 420, size: 26, font: bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: { type: "degrees", angle: 30 } });
  p.drawText(title, { x: 40, y: 750, size: 16, font: bold, color: ink });
  p.drawText("Tax Year 2025 · Sample prepared for the SignClear demo (PayPal AI Hackathon)", { x: 40, y: 732, size: 9, font, color: soft });
  p.drawLine({ start: { x: 40, y: 724 }, end: { x: 572, y: 724 }, thickness: 1, color: soft });
  let y = 700;
  for (const [line, label, value] of rows) {
    p.drawText(String(line), { x: 40, y, size: 10, font: bold, color: ink });
    p.drawText(label, { x: 90, y, size: 10, font, color: ink });
    p.drawText(value, { x: 470, y, size: 10, font: bold, color: ink });
    p.drawLine({ start: { x: 40, y: y - 6 }, end: { x: 572, y: y - 6 }, thickness: 0.3, color: rgb(0.85, 0.85, 0.85) });
    y -= 24;
  }
  extra(p, y);
}

page("Form 1040 — U.S. Individual Income Tax Return (sample)", [
  ["", "Name / SSN", `${NAME} · ***-**-4821`],
  ["", "Filing status", "Head of household"],
  ["", "Dependents", "2 (2015 daughter, 2018 son)"],
  ["1z", "Wages (Form W-2)", "18,400.00"],
  ["8", "Additional income (Schedule 1 · Schedule C)", "14,200.00"],
  ["11", "Adjusted gross income", "31,597.00"],
  ["12", "Standard deduction (head of household)", "23,625.00"],
  ["19", "Child tax credit (Schedule 8812)", "797.00"],
  ["23", "Other taxes · self-employment tax (Schedule 2)", "2,006.00"],
  ["24", "Total tax", "2,006.00"],
  ["25d", "Federal income tax withheld", "920.00"],
  ["27", "Earned income credit (EIC)", "5,415.00"],
  ["28", "Additional child tax credit (Schedule 8812)", "3,400.00"],
  ["35a", "Refund", "7,729.00"],
  ["35b", "Routing number", "*********"],
  ["35c", "Type", "Checking"],
  ["35d", "Account number", "****1234"],
]);

page("Form 1040 — page 2 · Paid Preparer Use Only (sample)", [
  ["", "Preparer's name", "Luis Pérez"],
  ["", "Preparer's signature", "/s/ Luis Pérez"],
  ["", "PTIN", "P01234567"],
  ["", "Firm's name", "Pérez Tax Prep"],
  ["", "Self-employed", "No"],
]);

page("Schedule C — Profit or Loss From Business (sample)", [
  ["A", "Principal business", "House cleaning"],
  ["1", "Gross receipts", "16,900.00"],
  ["28", "Total expenses", "2,700.00"],
  ["31", "Net profit", "14,200.00"],
]);

page("Form 8879 — IRS e-file Signature Authorization (sample, unsigned)", [
  ["1", "Adjusted gross income", "31,597.00"],
  ["2", "Total tax", "2,006.00"],
  ["3", "Federal income tax withheld", "920.00"],
  ["4", "Amount you want refunded to you", "7,729.00"],
  ["", "Taxpayer signature", "(to be signed after review)"],
  ["", "ERO", "Luis Pérez · EFIN 123456"],
]);

writeFileSync(`public/samples/${FILE}`, await pdf.save());
console.log(`wrote public/samples/${FILE}`);
}
