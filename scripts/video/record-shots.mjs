// Records the submission-video shots from the running app with a visible, smoothly moving cursor.
// Each shot → scratch/shots/<name>/frames + <name>.ffconcat (wall-clock timing) → mp4 via ffmpeg.
// Usage: node scripts/video/record-shots.mjs [shot ...]   (default: all)
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const FF = process.env.FFMPEG ?? "ffmpeg";
const ROOT = "scratch/shots";
const W = 1600, H = 1000;

// A drawn cursor (headless browsers don't render one) + click ripple.
const CURSOR = `
(() => {
  const mk = () => {
    if (document.getElementById("__cur")) return;
    const c = document.createElement("div");
    c.id = "__cur";
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.5 L14.4 20.3 L11.3 13.7 L17.5 13.7 Z" fill="#161513" stroke="#fffdf6" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none", transform: "translate(-200px,-200px)", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" });
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; }, true);
    addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      Object.assign(r.style, { position: "fixed", left: e.clientX - 22 + "px", top: e.clientY - 22 + "px", width: "44px", height: "44px", borderRadius: "50%", border: "3px solid #e3f23a", background: "rgba(227,242,58,.35)", zIndex: 2147483646, pointerEvents: "none", transition: "transform .5s ease-out, opacity .5s ease-out" });
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mk); else mk();
})();`;

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "chrome", headless: true });

async function shot(name, fn) {
  const dir = `${ROOT}/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/frames`, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.2 });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  let mx = W / 2, my = H / 2;
  const wait = (ms) => page.waitForTimeout(ms);
  const glideTo = async (x, y, ms = 900) => {
    const steps = Math.max(8, Math.round(ms / 30));
    const sx = mx, sy = my;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease in-out
      await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
      await wait(ms / steps);
    }
    mx = x; my = y;
  };
  const point = async (loc, ms = 900, dx = 0.5, dy = 0.5) => {
    const el = typeof loc === "string" ? page.locator(loc).first() : loc.first();
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 2000 });
      const b = await el.boundingBox();
      if (b) await glideTo(b.x + b.width * dx, b.y + b.height * dy, ms);
      return !!b;
    } catch { return false; }
  };
  const click = async (loc, ms = 900) => {
    if (await point(loc, ms)) {
      await wait(200);
      await page.mouse.down(); await wait(90); await page.mouse.up();
      await wait(250);
    }
  };
  const scrollBy = async (px, steps = 18, pause = 70) => { for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await wait(pause); } };

  // Chrome screencast: a frame on every paint, each with its own timestamp → smooth, wall-clock accurate.
  const frames = []; const t0 = Date.now();
  const { writeFileSync: wf } = await import("node:fs");
  const cdp = await ctx.newCDPSession(page);
  let n = 0, firstTs = null;
  cdp.on("Page.screencastFrame", async (ev) => {
    const f = `frames/f${String(n++).padStart(5, "0")}.jpg`;
    wf(`${dir}/${f}`, Buffer.from(ev.data, "base64"));
    const ts = ev.metadata.timestamp * 1000;
    if (firstTs === null) firstTs = ts - (Date.now() - t0);
    frames.push({ f, at: ts - firstTs });
    cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
  const loop = Promise.resolve();
  let rec = true;
  const marks = [];
  const mark = (label) => { marks.push({ label, at: (Date.now() - t0) / 1000 }); console.log(name, label, marks.at(-1).at.toFixed(1)); };
  try {
    await fn({ page, wait, glideTo, point, click, scrollBy, mark });
  } finally {
    rec = false; await loop; await cdp.send("Page.stopScreencast").catch(() => {}); await new Promise((r) => setTimeout(r, 300));
    frames.sort((x, y) => x.at - y.at);
    const endAt = Date.now() - t0;
    const lines = ["ffconcat version 1.0"];
    // Video time == wall-clock time since t0: the first frame covers [0, its time], the last one lasts until the end.
    if (frames.length && frames[0].at > 0) lines.push(`file '${frames[0].f}'`, `duration ${(frames[0].at / 1000).toFixed(3)}`);
    frames.forEach((fr, i) => { const nx = frames[i + 1]?.at ?? endAt; lines.push(`file '${fr.f}'`, `duration ${(Math.max(0.001, nx - fr.at) / 1000).toFixed(3)}`); });
    if (frames.length) lines.push(`file '${frames.at(-1).f}'`);
    writeFileSync(`${dir}/frames.ffconcat`, lines.join(String.fromCharCode(10)));
    writeFileSync(`${dir}/marks.json`, JSON.stringify(marks, null, 1));
    await ctx.close();
    execFileSync(FF, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}/frames.ffconcat`, "-vf", "fps=30,scale=1920:1200:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "medium", `${ROOT}/${name}.mp4`]);
    console.log(name, "→", `${ROOT}/${name}.mp4`, frames.length, "frames", ((Date.now() - t0) / 1000).toFixed(1), "s");
  }
}

const SHOTS = {
  // Landing: read the headline, point at the promise, click the 90-second story.
  landing: async ({ page, wait, glideTo, point, click, mark }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await glideTo(300, 700, 10); await wait(1500); mark("start");
    await point("h1", 1200, 0.3, 0.6); await wait(1800);
    await point("text=PayPal pays the preparer", 1000).catch(() => {}); await wait(1500);
    await point("text=NOT APPROVED", 1000); await wait(2000);
    mark("click");
    await click(page.getByText(/Watch SignClear in 90 seconds/i), 1100);
    await wait(2500); mark("end");
  },
  // The whole live story (real engine + PayPal sandbox), cursor pointing at what matters at each step.
  story: async ({ page, wait, point, mark }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByText(/Watch SignClear in 90 seconds/i).first().click();
    mark("start");
    let last = "";
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (await page.locator("[data-tour-finale]").first().isVisible().catch(() => false)) break;
      const title = (await page.locator("[data-tour-title]").first().textContent().catch(() => "")) ?? "";
      if (title && title !== last) {
        last = title; mark(title.trim());
        await wait(700);
        if (/Fraud caught/i.test(title)) { await point("text=This money would not go", 900); await wait(1600); await point("text=****9931", 700); await wait(1400); await point("text=is reading your return", 900).catch(() => {}); await wait(1200); }
        else if (/corrected return/i.test(title)) { await point("text=Use the sample return", 900); }
        else if (/AUTHORIZES/i.test(title)) { await wait(2500); await point("text=Authorization recorded", 1000); }
        else if (/files with the IRS/i.test(title)) { await point("text=Submission ID", 900); }
        else if (/paid now/i.test(title)) { await wait(1200); await point("[data-tour-refused]", 900); await wait(1200); await point("text=Capture refused", 900); }
        else if (/acknowledgment verified|CAPTURES/i.test(title)) { await wait(2500); await point("text=IRS acceptance verified", 900); await wait(1200); await point("text=Capture authorization", 900); }
        else if (/short/i.test(title)) { await point("text=Report", 900); }
        else if (/transcript/i.test(title)) { await wait(2000); await point("text=Form 8888", 900); }
        else if (/72 hours/i.test(title)) { await point("text=72", 900); }
        else if (/REFUNDS/i.test(title)) { await wait(2500); await point("text=Refund capture", 900); }
      }
      await wait(300);
    }
    mark("finale"); await wait(1200);
    await point("text=The AI explained every step", 1000); await wait(2000);
    await point("[data-tour-finale] >> text=Debug-ID", 900).catch(() => {}); await wait(3000);
    mark("end");
  },
  // Agent Arena: pick the malicious scenario, read the verdict, glance at both columns.
  arena: async ({ page, wait, click, point, scrollBy, mark }) => {
    await page.goto(`${BASE}/arena`, { waitUntil: "networkidle" });
    await wait(1200); mark("start");
    await click(page.getByText(/^Malicious$/), 1000); await wait(1500);
    await point("text=Without SignClear: $12,060", 1100, 0.3); await wait(2500);
    await point("text=With SignClear: blocked", 1000, 0.5).catch(() => {}); await wait(2000);
    await scrollBy(520); await wait(800);
    await point("text=Key moments", 900); await wait(2200);
    await scrollBy(-520); await wait(600); await click(page.getByText(/^Forged acceptance$/), 1000).catch(() => {}); await wait(1500); await point("text=forged acceptance refused", 1000).catch(() => {}); await wait(2600);
    mark("end");
  },
  // Fraud Lab: the four big numbers, then the radar.
  lab: async ({ page, wait, point, scrollBy, mark }) => {
    await page.goto(`${BASE}/lab`, { waitUntil: "networkidle" });
    await wait(1200); mark("start");
    await point("text=We attacked our own client", 1000, 0.3); await wait(1800);
    await scrollBy(420); await wait(700);
    await point("text=Frauds stopped before money moved", 900).catch(() => {}); await wait(1600);
    await point("text=Money moved wrongly", 900).catch(() => {}); await wait(1600);
    await point("text=Prompt-injection cases stopped", 900).catch(() => {}); await wait(1600);
    mark("radar");
    await page.goto(`${BASE}/radar`, { waitUntil: "networkidle" }); await wait(1000);
    await point("text=A preparer's pattern is harder to hide", 1000, 0.3).catch(() => {}); await wait(2200);
    mark("end");
  },
  // API & MCP: one-line install for any AI preparer.
  connect: async ({ page, wait, point, mark }) => {
    await page.goto(`${BASE}/connect`, { waitUntil: "networkidle" });
    await wait(1000); mark("start");
    await point("text=Connect your", 900, 0.4); await wait(1500);
    await point("text=claude mcp add", 1000).catch(() => {}); await wait(2500);
    await point("text=request_fee_capture", 900).catch(() => {}); await wait(2000);
    mark("end");
  },
};

const want = process.argv.slice(2);
for (const [name, fn] of Object.entries(SHOTS)) if (!want.length || want.includes(name)) await shot(name, fn);
await browser.close();
