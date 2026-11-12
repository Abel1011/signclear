"use client";
import { useCallback, useEffect, useState } from "react";
import type { Row } from "@/lib/rows";
import type { Finding, Intake } from "@/lib/rules";
import { brand } from "@/lib/brand";

export type Lang = "es" | "en" | "pt";
export type L10n = { es: string; en: string; pt: string };

export type CaseView = {
  id: string;
  role: "client" | "preparer";
  state: string;
  scenario: string | null;
  isDemo: boolean;
  lang: Lang;
  clientName: string;
  fee: number;
  preparer: { name: string; business: string; ptin: string; efin: string };
  intake: Intake | null;
  intakeChanges: number;
  rows: Row[];
  findings: Finding[];
  confirmed?: number;
  payment: null | { orderId: string | null; authorizationId: string | null; captureId: string | null; refundId: string | null; status: string; amount: number; expirationTime: string | null; payerName: string | null; lastDebugId: string | null };
  r15: boolean;
  ackDeadline: string | null;
  refundDeadline: string | null;
  now: string;
  clockOffsetHours: number;
  submissionId: string | null;
  ackReceivedAt: string | null;
  lastAck?: AckView | null;
  preparerVerdict: string | null;
  approvedRefund: number | null;
  reportedRefund: number | null;
  hasTranscript: boolean;
  accuracy: { ok: number; total: number } | null;
  guards: { capture: string[]; refund: string[] };
  refundWindowOpen?: boolean;
  sample?: boolean;
  diversion?: { acct: string; amount: number; mainAcct: string; mainAmount: number } | null;
  notifications: { id: string; text: L10n; read: boolean; at: string }[];
  chat: { id: string; role: string; text: string; focusRow: string | null; at: string; stale?: "resolved" | "earlier" | null }[];
  audit?: AuditRow[];
  tokens?: { client: string; preparer: string };
};

export type AckView = {
  at: string;
  verdict: "ACCEPTED" | "REJECTED_BY_IRS" | "REFUSED";
  mode: string;
  read: { is_efile_acknowledgment: boolean; submission_id: string | null; status: string; efin: string | null; taxpayer_name: string | null; ssn_last4: string | null; tax_year: number | null; ack_date: string | null; transmitted_date: string | null };
  checks: { id: string; ok: boolean; detail: string }[];
};

export type AuditRow = { id: string; at: string; actor: string; action: string; rationale: string | null; from: string | null; to: string | null; debugId: string | null; detail: Record<string, unknown> };

export function useCase(token: string | null, opts: { audit?: boolean; interval?: number } = {}) {
  const [data, setData] = useState<CaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!token) return;
    const r = await fetch(`/api/case/${token}${opts.audit ? "?audit=1" : ""}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) setError(j.error ?? "error");
    else setData(j);
  }, [token, opts.audit]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, opts.interval ?? 1500);
    return () => clearInterval(t);
  }, [refresh, opts.interval]);
  const act = useCallback(
    async (type: string, extra: Record<string, unknown> = {}) => {
      const r = await fetch(`/api/case/${token}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...extra }) });
      const j = await r.json().catch(() => ({}));
      await refresh();
      return j as Record<string, unknown>;
    },
    [token, refresh],
  );
  return { data, error, refresh, act };
}

export const usd = (cents?: number | null) =>
  cents === null || cents === undefined ? "—" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
export const tr = (m: L10n | string, lang: Lang) => brand(typeof m === "string" ? m : m[lang] ?? m.en);
export const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
