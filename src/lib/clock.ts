export const H = 3600_000;
export const D = 24 * H;

export function now(c: { clockOffsetMs?: number | null }): Date {
  return new Date(Date.now() + (c.clockOffsetMs ?? 0));
}

/** Deadline for the IRS confirmation: min(max(approval, seasonOpen) + 5d, authCreated + 28d). */
export function ackDeadline(approvedAt: Date, seasonOpen: Date | null, authCreated: Date): Date {
  const base = Math.max(approvedAt.getTime(), (seasonOpen ?? approvedAt).getTime());
  return new Date(Math.min(base + 5 * D, authCreated.getTime() + 28 * D));
}
