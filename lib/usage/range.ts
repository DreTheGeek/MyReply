import { z } from "zod";

/**
 * The from and to of a usage query: UTC days, inclusive. Left out, it is the
 * current month so far, which is what a monthly bill reads.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Days are YYYY-MM-DD");
const MAX_DAYS = 366;

export type UsageRange = { ok: true; from: Date; to: Date } | { ok: false; error: string };

export function parseUsageRange(search: URLSearchParams, now: Date = new Date()): UsageRange {
  const parsed = z
    .object({ from: day.optional(), to: day.optional() })
    .safeParse({ from: search.get("from") ?? undefined, to: search.get("to") ?? undefined });
  if (!parsed.success) return { ok: false, error: "from and to are days, written YYYY-MM-DD." };

  const from = parsed.data.from
    ? new Date(`${parsed.data.from}T00:00:00Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = parsed.data.to ? new Date(`${parsed.data.to}T00:00:00Z`) : now;
  // A day that does not exist (2026-02-31) rolls over silently in Date, so
  // each one is checked by writing it back out.
  const real = (value: string | undefined, date: Date): boolean =>
    value === undefined || (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value);
  if (!real(parsed.data.from, from) || !real(parsed.data.to, to)) {
    return { ok: false, error: "from and to must be real days." };
  }
  if (from > to) return { ok: false, error: "from must be on or before to." };
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_DAYS) {
    return { ok: false, error: `Ask for at most ${MAX_DAYS} days at a time.` };
  }
  return { ok: true, from, to };
}
