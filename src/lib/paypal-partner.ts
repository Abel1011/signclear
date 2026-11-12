// Multiparty onboarding (Partner Referrals v2): the preparer connects their own PayPal business account and
// becomes the merchant of record; SignClear takes a platform fee on capture. Behind MULTIPARTY=1.
import { db } from "./db";
import { paypal, multipartyEnabled } from "./paypal";

export type OnboardingStatus = {
  multiparty: boolean;
  merchantId: string | null;
  onboardedAt: Date | null;
  permissions: Record<string, unknown> | null;
};

export async function onboardingStatus(preparerId: string): Promise<OnboardingStatus> {
  const p = await db.preparer.findUniqueOrThrow({ where: { id: preparerId } });
  return {
    multiparty: multipartyEnabled(),
    merchantId: p.paypalMerchantId,
    onboardedAt: p.paypalOnboardedAt,
    permissions: p.paypalPermissions ? (JSON.parse(p.paypalPermissions) as Record<string, unknown>) : null,
  };
}

/** Creates the partner referral and returns PayPal's onboarding URL (link rel "action_url"). */
export async function startOnboarding(preparerId: string, returnUrl: string) {
  if (!multipartyEnabled()) return { ok: false as const, blocked: ["MULTIPARTY is off: fees go to the platform PayPal account"] };
  const trackingId = `sc-${preparerId}`;
  const res = await paypal.createPartnerReferral({ trackingId, returnUrl });
  const url = res.body?.links?.find((l) => l.rel === "action_url")?.href;
  if (!res.ok || !url) {
    const name = (res.body as { name?: string } | null)?.name;
    return { ok: false as const, blocked: [`PayPal ${name ?? "error"} (HTTP ${res.status})`], debugId: res.debugId };
  }
  await db.preparer.update({ where: { id: preparerId }, data: { paypalTrackingId: trackingId } });
  return { ok: true as const, url, debugId: res.debugId };
}

/**
 * Return URL handler. PayPal appends merchantId (our tracking id), merchantIdInPayPal, permissionsGranted,
 * consentStatus, isEmailConfirmed, accountStatus. With PAYPAL_PARTNER_MERCHANT_ID set we also confirm the
 * seller's status server-side (payments_receivable / primary_email_confirmed) instead of trusting the query.
 */
export async function completeOnboarding(q: URLSearchParams) {
  const tracking = q.get("merchantId") ?? "";
  const seller = q.get("merchantIdInPayPal") ?? "";
  if (!tracking.startsWith("sc-") || !/^[A-Z0-9]{8,20}$/.test(seller)) return { ok: false, blocked: ["invalid onboarding return"] };
  const p = await db.preparer.findFirst({ where: { paypalTrackingId: tracking } });
  if (!p) return { ok: false, blocked: ["unknown onboarding"] };
  const perms: Record<string, unknown> = {
    permissionsGranted: q.get("permissionsGranted") === "true",
    consentStatus: q.get("consentStatus") === "true",
    isEmailConfirmed: q.get("isEmailConfirmed") === "true",
    accountStatus: q.get("accountStatus"),
  };
  const partner = process.env.PAYPAL_PARTNER_MERCHANT_ID;
  if (partner) {
    const r = await paypal.getMerchantIntegration(partner, seller);
    perms.verified = r.ok;
    perms.debugId = r.debugId;
    if (r.ok) {
      perms.payments_receivable = r.body?.payments_receivable;
      perms.primary_email_confirmed = r.body?.primary_email_confirmed;
    }
  }
  const usable = perms.permissionsGranted === true && (perms.verified === undefined || perms.payments_receivable === true);
  await db.preparer.update({
    where: { id: p.id },
    data: { paypalMerchantId: usable ? seller : null, paypalOnboardedAt: usable ? new Date() : null, paypalPermissions: JSON.stringify(perms) },
  });
  return { ok: usable, merchantId: usable ? seller : null, permissions: perms };
}
