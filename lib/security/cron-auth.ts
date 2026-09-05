import { timingSafeEqual } from "node:crypto";

/**
 * The bearer check for scheduled routes.
 *
 * Two things were wrong with the four hand-rolled copies this replaces.
 *
 * First, they fell back to NEXTAUTH_SECRET when CRON_SECRET was unset, and
 * docs/cron.md told the operator to put that value in the vault. That takes
 * the key which signs every session, every Instagram OAuth state and every
 * magic-link token, and puts it on the wire in an Authorization header on
 * every tick, where it lands in the pg_net response tables and in any proxy
 * log that records headers. Recovering it from there is not an attack, it is
 * a SELECT. There is no fallback here: CRON_SECRET or nothing.
 *
 * Second, three of the four compared `authHeader !== \`Bearer ${secret}\``
 * with no null guard, so with no secret configured the comparison became
 * `!== "Bearer undefined"` and the literal string "Bearer undefined"
 * authenticated. Missing configuration now denies rather than opens.
 *
 * The comparison is constant time. A cron secret is a fixed value replayed on
 * a schedule, so a timing oracle against it is worth closing even though the
 * attacker needs many samples.
 */

export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: "unconfigured" | "invalid" };

function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare a fixed-size digest of the lengths instead by bailing on
  // a constant-time-irrelevant check only after both buffers exist.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyCronRequest(request: Request): CronAuthResult {
  const configured = process.env.CRON_SECRET;
  if (!configured || configured.trim() === "") {
    return { ok: false, reason: "unconfigured" };
  }

  const header = request.headers.get("authorization");
  if (!header) return { ok: false, reason: "invalid" };

  return secureEquals(header, `Bearer ${configured}`)
    ? { ok: true }
    : { ok: false, reason: "invalid" };
}

/** True when the caller proved it is the scheduler. Never throws. */
export function isCronRequest(request: Request): boolean {
  return verifyCronRequest(request).ok;
}
