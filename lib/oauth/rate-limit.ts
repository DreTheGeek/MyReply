/**
 * A small fixed-window limiter for the unauthenticated OAuth endpoints.
 *
 * In process and per instance on purpose: the shared Redis in this codebase is
 * the DM send budget, and borrowing it here would couple sign-in traffic to the
 * worker's availability. That makes this a speed bump against a single noisy
 * client rather than a distributed quota, which is the right shape for
 * registration and token requests. Anything stronger belongs at the edge.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Stops the map growing without bound on a long-lived instance. */
function sweep(now: number): void {
  if (windows.size < 5_000) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitDecision {
  const now = Date.now();
  sweep(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/** The caller's address, as far as the proxy in front of us reports it. */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** Test seam. Clears the windows so one test's traffic cannot fail the next. */
export function resetRateLimits(): void {
  windows.clear();
}
