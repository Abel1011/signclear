// Records a demo walkthrough of the running app (http://localhost:3000) with the installed Edge browser.
// Usage: node scripts/video/record-demo.mjs   → scratch/video/*.webm
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = "scratch/video";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// Frame recorder (no extra downloads): JPEG screenshots at ~4 fps with timestamps, stitched later by ffmpeg.
mkdirSync(`${OUT}/frames`, { recursive: true });
let recording = true;
const frames = [];
const startRec = Date.now();
(async () => {
  let n = 0;
  while (recording) {
    const t = Date.now();
    try {
      const file = `${OUT}/frames/f${String(n).padStart(5, "0")}.jpg`;
      await page.screenshot({ path: file, type: "jpeg", quality: 70, timeout: 5000 });
      frames.push({ file: `frames/f${String(n).padStart(5, "0")}.jpg`, at: t - startRec });
      n++;
    } catch (e) { if (n === 0) console.error("shot", String(e).slice(0, 200)); }
    const dt = Date.now() - t;
    await new Promise((r) => setTimeout(r, Math.max(0, 250 - dt)));
  }
})();
const wait = (ms) => page.waitForTimeout(ms);
const glide = async (px, steps = 12, pause = 120) => {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps);
    await wait(pause);
  }
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 1. Landing
log("landing");
await page.goto(BASE, { waitUntil: "networkidle" });
await wait(4000);
await page.mouse.move(720, 450);
await glide(1400, 20, 200);
await wait(2500);
await glide(-1400, 10, 80);
await wait(1500);

// 2. The 90-second story
log("story start");
await page.getByText(/Watch SignClear in 90 seconds/i).first().click();
const t0 = Date.now();
try {
  await page.locator("[data-tour-finale]").first().waitFor({ state: "visible", timeout: 300_000 });
  log(`story finished in ${Math.round((Date.now() - t0) / 1000)} s`);
} catch {
  log("story did NOT finish within 5 min");
}
await wait(9000);
// close the finale overlay if present and look around
const look = page.getByText(/Look around the screens/i).first();
if (await look.isVisible().catch(() => false)) {
  await look.click();
  await wait(3000);
}

// 3. Agent Arena
log("arena");
await page.goto(`${BASE}/arena`, { waitUntil: "networkidle" });
await wait(4000);
await glide(900, 15, 250);
await wait(2500);
await glide(900, 15, 250);
await wait(2500);

// 4. Fraud Lab
log("lab");
await page.goto(`${BASE}/lab`, { waitUntil: "networkidle" });
await wait(4000);
await glide(1200, 18, 250);
await wait(2500);

// 5. Radar
log("radar");
await page.goto(`${BASE}/radar`, { waitUntil: "networkidle" });
await wait(3500);
await glide(900, 14, 250);
await wait(2000);

// 6. Connect (API & MCP)
log("connect");
await page.goto(`${BASE}/connect`, { waitUntil: "networkidle" });
await wait(3500);
await glide(700, 10, 250);
await wait(2000);

recording = false;
await wait(600);
// ffmpeg concat list with real durations so playback matches wall-clock time
const { writeFileSync } = await import("node:fs");
const lines = ["ffconcat version 1.0"];
frames.forEach((f, i) => {
  const next = frames[i + 1]?.at ?? f.at + 250;
  lines.push(`file '${f.file}'`, `duration ${((next - f.at) / 1000).toFixed(3)}`);
});
lines.push(`file '${frames[frames.length - 1].file}'`);
writeFileSync(`${OUT}/frames.ffconcat`, lines.join(String.fromCharCode(10)));
await ctx.close();
await browser.close();
log(`done: ${frames.length} frames over ${Math.round((Date.now() - startRec) / 1000)} s`);
