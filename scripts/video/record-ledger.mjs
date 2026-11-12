// Records the buyer sandbox account ledger (authorizations, captures, refunds). Derived from record-checkout.mjs.
// Records the real PayPal sandbox approval for the submission video:
//   main  — the 90-second story runs to "corrected return", we take over, María clicks the PayPal button
//   popup — the real sandbox checkout window (buyer login + approve)
//   acct  — the buyer's sandbox account activity showing the $250 authorization
// Every page gets its own CDP screencast sharing one clock (t0), so the clips line up.
// Usage: PP_BUYER_EMAIL=… PP_BUYER_PASS=… node scripts/video/record-checkout.mjs
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const FF = process.env.FFMPEG ?? "ffmpeg";
const ROOT = "scratch/shots/ledger";
const W = 1600, H = 1000;
const EMAIL = process.env.PP_BUYER_EMAIL, PASS = process.env.PP_BUYER_PASS;
if (!EMAIL || !PASS) throw new Error("PP_BUYER_EMAIL / PP_BUYER_PASS missing");

const CURSOR = `
(() => {
  const mk = () => {
    if (document.getElementById("__cur") || !document.documentElement) return;
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
  if (window.top !== window) return; // only top documents (PayPal button iframes don't need one)
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mk); else mk();
})();`;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const t0 = Date.now();
const marks = [];
const mark = (label) => { marks.push({ label, at: (Date.now() - t0) / 1000 }); console.log(label, marks.at(-1).at.toFixed(1)); };

async function recorder(ctx, page, name) {
  const dir = `${ROOT}/${name}`;
  mkdirSync(`${dir}/frames`, { recursive: true });
  const frames = []; let n = 0, offset = null;
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", (ev) => {
    const f = `frames/f${String(n++).padStart(5, "0")}.jpg`;
    writeFileSync(`${dir}/${f}`, Buffer.from(ev.data, "base64"));
    const ts = ev.metadata.timestamp * 1000;
    if (offset === null) offset = ts - (Date.now() - t0);
    frames.push({ f, at: ts - offset });
    cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
  const startAt = (Date.now() - t0) / 1000;
  return {
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      frames.sort((a, b) => a.at - b.at);
      const endAt = Date.now() - t0;
      if (!frames.length) return console.log(name, "no frames");
      // Clip time 0 == first frame's wall-clock time; startAt recorded in marks for alignment.
      const first = frames[0].at;
      const lines = ["ffconcat version 1.0"];
      frames.forEach((fr, i) => { const nx = frames[i + 1]?.at ?? endAt; lines.push(`file '${fr.f}'`, `duration ${(Math.max(0.001, nx - fr.at) / 1000).toFixed(3)}`); });
      lines.push(`file '${frames.at(-1).f}'`);
      writeFileSync(`${dir}/frames.ffconcat`, lines.join(String.fromCharCode(10)));
      writeFileSync(`${dir}/clip.json`, JSON.stringify({ startsAt: first / 1000, requested: startAt }, null, 1));
      execFileSync(FF, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}/frames.ffconcat`, "-vf", "fps=30,scale=1920:-2:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "medium", `${ROOT}/${name}.mp4`]);
      console.log(name, "→", `${ROOT}/${name}.mp4`, frames.length, "frames, starts at", (first / 1000).toFixed(1));
    },
  };
}

function driver(page, w, h) {
  let mx = w / 2, my = h / 2;
  const wait = (ms) => page.waitForTimeout(ms);
  const glideTo = async (x, y, ms = 900) => {
    const steps = Math.max(8, Math.round(ms / 30)); const sx = mx, sy = my;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e); await wait(ms / steps);
    }
    mx = x; my = y;
  };
  // Bounding boxes of elements inside iframes are already page-relative in Playwright.
  const point = async (loc, ms = 900, dx = 0.5, dy = 0.5) => {
    const el = typeof loc === "string" ? page.locator(loc).first() : loc.first();
    try { await el.waitFor({ state: "visible", timeout: 15000 }); await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {}); const b = await el.boundingBox(); if (b) await glideTo(b.x + b.width * dx, b.y + b.height * dy, ms); return !!b; } catch { return false; }
  };
  const click = async (loc, ms = 900) => { if (await point(loc, ms)) { await wait(200); await page.mouse.down(); await wait(90); await page.mouse.up(); await wait(250); return true; } return false; };
  const type = async (text) => { for (const ch of text) { await page.keyboard.type(ch); await wait(45 + (ch.charCodeAt(0) % 5) * 12); } };
  return { wait, glideTo, point, click, type };
}

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.2, locale: "en-US" });
await ctx.addInitScript(CURSOR);
const pg = await ctx.newPage();
await pg.goto("https://www.sandbox.paypal.com/myaccount/activities/", { waitUntil: "domcontentloaded" });
await pg.locator("#email").waitFor({ timeout: 30000 });
await pg.fill("#email", EMAIL); await pg.locator("#btnNext").click().catch(() => {});
await pg.locator("#password").waitFor({ state: "visible", timeout: 30000 });
await pg.fill("#password", PASS); await pg.locator("#btnLogin").click();
await pg.waitForURL(/activities/, { timeout: 90000 }).catch(() => {});
await pg.getByText("Pendiente").first().waitFor({ timeout: 90000 });
await pg.waitForTimeout(3000);
await pg.getByRole("button", { name: /^Close$|Cerrar/ }).last().click({ timeout: 3000 }).catch(() => {});
await pg.waitForTimeout(800);
const rec = await recorder(ctx, pg, "ledger");
const d = driver(pg, W, H);
try {
  await d.glideTo(900, 600, 10); await d.wait(1200); mark("start");
  await d.point(pg.getByText("Pendiente").first(), 900); await d.wait(900);
  await d.point(pg.getByText(/Autorizaci/).first(), 900); await d.wait(1500);
  mark("pending");
  const done = pg.getByText("Completado").first();
  const box = await done.boundingBox();
  const target = (box?.y ?? 900) - 160;
  for (let i = 0; i < 30; i++) { await pg.mouse.wheel(0, target / 30); await d.wait(40); }
  await d.wait(900); mark("completed");
  await d.point(pg.getByText(/Reembolsar/).first(), 900); await d.wait(1600);
  await d.point(pg.getByText(/Reembolsado/).first(), 900); await d.wait(1600);
  const split = pg.getByText("+$70.00").first();
  const sb = await split.boundingBox();
  if (sb) { for (let i = 0; i < 30; i++) { await pg.mouse.wheel(0, (sb.y - 380) / 30); await d.wait(40); } }
  await d.wait(900); mark("split");
  await d.point(pg.getByText("+$70.00").first(), 900); await d.wait(1200);
  await d.point(pg.getByText("+$180.00").first(), 900); await d.wait(2200);
  mark("end");
} catch (e) { console.error("FAILED", e.message); }
await rec.stop();
writeFileSync(`${ROOT}/marks.json`, JSON.stringify(marks, null, 1));
await browser.close();
