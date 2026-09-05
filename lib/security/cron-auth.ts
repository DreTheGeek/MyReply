import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";

/**
 * The bearer check for scheduled routes.
 *
 * SUPABASE VAULT IS THE SOURCE OF TRUTH, not the hosting platform's
 * environment. pg_cron already reads this exact secret out of the vault to
 * build the Authorization header it sends (see the invoke() function in
 * 20260905000000_supabase_pg_cron_jobs). Having the receiving end read the
 * same row means the two cannot disagree: there is no second copy in Vercel to
 * drift, and rotating is one UPDATE that both sides pick up.
 *
 * That also removes a whole class of outage. Before this, the schedule and the
 * app each had their own copy, and a mismatch turned every job into a 401 with
 * nothing obviously wrong on either side.
 *
 * TWO THINGS DELIBERATELY NOT MOVED HERE, because moving them would be worse:
 *
 *   ENCRYPTION_KEY stays in the environment. It protects Instagram tokens
 *   stored in this same database. Putting the key in the database the
 *   ciphertext lives in makes the encryption decorative: one compromise then
 *   yields both halves. It has to live somewhere the database does not.
 *
 *   DATABASE_URL obviously stays too. It is how we reach the vault.
 *
 * The env var remains as a fallback for self-hosters running without Supabase,
 * which the project supports. The vault wins whenever it has a value.
 */

export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: "unconfigured" | "invalid" };

/**
 * Cached because a cold serverless invocation would otherwise pay a database
 * round trip before it can reject an unauthenticated request, which is a free
 * denial-of-service lever. Five minutes bounds how long a rotation takes to
 * apply; the jobs run no more often than that.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { secret: string | null; readAt: number } | null = null;

/** Exposed for tests, which must not inherit a value across cases. */
export function resetCronSecretCache(): void {
  cached = null;
}

async function readVaultSecret(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<{ decrypted_secret: string | null }[]>`
      SELECT decrypted_secret
        FROM vault.decrypted_secrets
       WHERE name = 'myreply_cron_secret'
       LIMIT 1
    `;
    const secret = rows[0]?.decrypted_secret ?? null;
    return secret && secret.trim() !== "" ? secret.trim() : null;
  } catch (error) {
    // A vault that cannot be read is not an open door. It falls through to the
    // env fallback and, failing that, denies. Logged because a scheduled job
    // silently 401ing is exactly the outage this design exists to avoid.
    console.error(
      "[Cron] Could not read myreply_cron_secret from the vault",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

async function resolveSecret(): Promise<string | null> {
  const now = Date.now();
  if (cached && now - cached.readAt < CACHE_TTL_MS) return cached.secret;

  const fromVault = await readVaultSecret();
  const fromEnv = process.env.CRON_SECRET?.trim();
  const secret = fromVault ?? (fromEnv && fromEnv !== "" ? fromEnv : null);

  cached = { secret, readAt: now };
  return secret;
}

function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function verifyCronRequest(
  request: Request
): Promise<CronAuthResult> {
  const configured = await resolveSecret();
  if (!configured) return { ok: false, reason: "unconfigured" };

  const header = request.headers.get("authorization");
  if (!header) return { ok: false, reason: "invalid" };

  return secureEquals(header, `Bearer ${configured}`)
    ? { ok: true }
    : { ok: false, reason: "invalid" };
}

/** True when the caller proved it is the scheduler. Never throws. */
export async function isCronRequest(request: Request): Promise<boolean> {
  return (await verifyCronRequest(request)).ok;
}
