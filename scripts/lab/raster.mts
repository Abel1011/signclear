// Rasterization for the Fraud Lab's unseen set: turns a text PDF into what clients actually upload —
// a flatbed/office scan or a phone photo — so the quarantined reader has to do real OCR.
//   scan  : 150 dpi, grayscale, 0.3–1.4° skew, sensor noise + speckle, light blur, JPEG; some pages binarized (fax look)
//   photo : 100 dpi, paper on a desk, 1.5–3.5° rotation + slight shear, uneven light/shadow, warm tint, blur, JPEG q≈48
// Pages are packed into an image-only PDF (no text layer), exactly like a scanner app produces.
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

export type Condition = "pdf" | "scan" | "photo";
type Rnd = () => number;

export async function renderPages(pdfBytes: Uint8Array, dpi: number): Promise<Canvas[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/", verbosity: 0 }).promise;
  const out: Canvas[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: dpi / 72 });
    const cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx as never, viewport: vp }).promise;
    out.push(cv);
  }
  await doc.destroy();
  return out;
}

const gauss = (rnd: Rnd) => (rnd() + rnd() + rnd() - 1.5) * 1.15;

function pixels(ctx: SKRSContext2D, w: number, h: number, f: (r: number, g: number, b: number, i: number) => [number, number, number]) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = f(d[i], d[i + 1], d[i + 2], i / 4);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
}
const clamp = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : x);

export function scanPage(src: Canvas, rnd: Rnd, opts: { binarize?: boolean } = {}): Canvas {
  const w = src.width;
  const h = src.height;
  const cv = createCanvas(w, h);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#f3f2ee";
  ctx.fillRect(0, 0, w, h);
  const angle = ((rnd() < 0.5 ? -1 : 1) * (0.3 + rnd() * 1.1) * Math.PI) / 180;
  ctx.save();
  ctx.translate(w / 2 + (rnd() - 0.5) * 18, h / 2 + (rnd() - 0.5) * 18);
  ctx.rotate(angle);
  ctx.filter = "blur(0.45px)";
  ctx.drawImage(src, -w / 2, -h / 2);
  ctx.restore();
  ctx.filter = "none";
  const contrast = 1.1 + rnd() * 0.15;
  pixels(ctx, w, h, (r, g, b) => {
    let y = 0.299 * r + 0.587 * g + 0.114 * b;
    y = (y - 128) * contrast + 128 + gauss(rnd) * 9;
    if (rnd() < 0.0009) y = 40 + rnd() * 60; // dust speckle
    if (opts.binarize) y = y < 165 ? 18 : 246;
    y = clamp(y);
    return [y, y, y];
  });
  return cv;
}

export function photoPage(src: Canvas, rnd: Rnd): Canvas {
  const w = Math.round(src.width * 1.08);
  const h = Math.round(src.height * 1.06);
  const cv = createCanvas(w, h);
  const ctx = cv.getContext("2d");
  // desk
  const desk = ctx.createLinearGradient(0, 0, w, h);
  desk.addColorStop(0, "#5b4636");
  desk.addColorStop(1, "#3d2f25");
  ctx.fillStyle = desk;
  ctx.fillRect(0, 0, w, h);
  const angle = ((rnd() < 0.5 ? -1 : 1) * (1.5 + rnd() * 2) * Math.PI) / 180;
  const shear = (rnd() - 0.5) * 0.04;
  ctx.save();
  ctx.translate(w / 2 + (rnd() - 0.5) * 20, h / 2 + (rnd() - 0.5) * 20);
  ctx.rotate(angle);
  ctx.transform(1, shear * 0.5, shear, 1, 0, 0);
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 18;
  ctx.filter = "blur(0.75px)";
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  ctx.filter = "none";
  // uneven light: a soft shadow from one side (the phone / the hand) and a warm indoor tint
  ctx.globalCompositeOperation = "multiply";
  const sx = rnd() < 0.5 ? 0 : w;
  const shade = ctx.createLinearGradient(sx, 0, w - sx, h * (0.3 + rnd() * 0.5));
  shade.addColorStop(0, `rgba(70,70,80,${0.35 + rnd() * 0.2})`);
  shade.addColorStop(0.55, "rgba(255,255,255,0)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255,236,205,0.6)";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  pixels(ctx, w, h, (r, g, b) => {
    const n = gauss(rnd) * 7;
    return [clamp(r + n), clamp(g + n), clamp(b + n)];
  });
  return cv;
}

export async function toJpeg(cv: Canvas, quality: number): Promise<Buffer> {
  // canvas' own JPEG encoder occasionally returns an invalid stream on large noisy pages: encode with sharp
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(await cv.encode("png"))).jpeg({ quality, mozjpeg: true }).toBuffer();
}

/** Image-only PDF (one JPEG per page, letter-size pages, no text layer). */
export async function imagePdf(jpegs: Buffer[], title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer("SignClear Fraud Lab (synthetic scan)");
  for (const j of jpegs) {
    const img = await pdf.embedJpg(j);
    const scale = Math.min(612 / img.width, 792 / img.height);
    const page = pdf.addPage([612, 792]);
    page.drawImage(img, { x: (612 - img.width * scale) / 2, y: (792 - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
  }
  return pdf.save();
}
