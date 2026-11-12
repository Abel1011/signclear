import { NextResponse } from "next/server";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { reconcileWebhook } from "@/lib/money";

export const dynamic = "force-dynamic";

const CERT_TTL_MS = 12 * 3600_000;
const CERT_MAX = 20;
const certCache = new Map<string, { pem: string; at: number }>();

async function getCert(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !(u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"))) throw new Error("bad cert host");
  const hit = certCache.get(url);
  if (hit && Date.now() - hit.at < CERT_TTL_MS) return hit.pem;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`cert fetch ${res.status}`);
  const pem = await res.text();
  if (certCache.size >= CERT_MAX) certCache.delete(certCache.keys().next().value!);
  certCache.set(url, { pem, at: Date.now() });
  return pem;
}

// Self-verification: RSA-SHA256 over `transmissionId|timeStamp|webhookId|crc32(rawBody)`.
// Webhooks reconcile state idempotently (money.reconcileWebhook); they never trigger the agent.
export async function POST(req: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    // Fail closed: without the webhook id nothing can be verified.
    console.error("PAYPAL_WEBHOOK_ID missing: rejecting webhook");
    return NextResponse.json({ error: "webhook verification not configured" }, { status: process.env.NODE_ENV === "production" ? 503 : 400 });
  }
  const raw = await req.text();
  const h = req.headers;
  let verified = false;
  try {
    const crc = (zlib as unknown as { crc32: (b: Buffer) => number }).crc32(Buffer.from(raw, "utf8"));
    const msg = `${h.get("paypal-transmission-id")}|${h.get("paypal-transmission-time")}|${webhookId}|${crc}`;
    const cert = await getCert(String(h.get("paypal-cert-url")));
    verified = crypto.createVerify("sha256").update(msg).verify(cert, String(h.get("paypal-transmission-sig")), "base64");
  } catch (e) {
    console.error("webhook verify", e);
  }
  if (!verified) return NextResponse.json({ error: "signature not verified" }, { status: 400 });
  let ev: { id: string; event_type: string; resource?: Record<string, unknown> };
  try {
    ev = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  let row: { id: string };
  try {
    row = await db.webhookEvent.create({ data: { eventId: ev.id, eventType: ev.event_type, verified, resource: raw.slice(0, 4000) } });
  } catch {
    return NextResponse.json({ duplicate: true }); // dedupe by event.id
  }
  try {
    const r = await reconcileWebhook(ev as Parameters<typeof reconcileWebhook>[0]);
    if (r.caseId) await audit(r.caseId, "paypal", `webhook:${ev.event_type}`, { detail: { verified, eventId: ev.id, reconciled: r.action } });
    return NextResponse.json({ ok: true, verified, reconciled: r.action });
  } catch (e) {
    // Let PayPal redeliver: forget the dedupe row so the retry is processed.
    console.error("webhook reconcile", ev.event_type, e);
    await db.webhookEvent.delete({ where: { id: row.id } }).catch(() => undefined);
    return NextResponse.json({ error: "reconcile failed" }, { status: 500 });
  }
}
