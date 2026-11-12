import { db } from "./db";
import type { L10n } from "./i18n";

export async function audit(
  caseId: string,
  actor: "ai" | "rules" | "user" | "paypal" | "system" | "guardian",
  action: string,
  opts: { rationale?: string; detail?: unknown; from?: string; to?: string; debugId?: string } = {},
) {
  await db.auditEvent.create({
    data: {
      caseId,
      actor,
      action,
      rationale: opts.rationale,
      detail: JSON.stringify(opts.detail ?? {}),
      fromState: opts.from,
      toState: opts.to,
      debugId: opts.debugId,
    },
  });
}

export async function notify(caseId: string, audience: "client" | "preparer", text: L10n) {
  await db.notification.create({ data: { caseId, audience, text: JSON.stringify(text) } });
  await audit(caseId, "system", "notification", { detail: { audience, text: text.en } });
}
