/**
 * Per-workspace throttle for Ask MyReply.
 *
 * The bill lands on the workspace's own provider account, so the thing being
 * protected is the tenant's balance rather than ours: a stuck client retrying
 * in a loop must not be able to spend a day's budget in a minute.
 *
 * In process rather than in Redis, on purpose. The DM worker's Redis limiter
 * guards a hard external cap that must hold across every instance; this guards
 * against runaway retries, where a per-instance ceiling is enough and is worth
 * more than adding a Redis round trip plus a Redis outage to the request path.
 * If MyReply ever runs many web instances per tenant, move it to the same
 * Redis counter the worker uses.
 */

export interface RateLimitWindow {
  /** How long the window is, in milliseconds. */
  ms: number;
  /** How many requests may start inside it. */
  max: number;
}

export const ASSISTANT_WINDOWS: readonly RateLimitWindow[] = [
  { ms: 60_000, max: 10 },
  { ms: 3_600_000, max: 120 },
] as const;

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until the caller may retry. Zero when allowed. */
  retryAfterSeconds: number;
}

const hits = new Map<string, number[]>();

/** Longest window we care about, so anything older can be dropped. */
const LONGEST_WINDOW_MS = ASSISTANT_WINDOWS.reduce(
  (longest, window) => Math.max(longest, window.ms),
  0
);

/**
 * Record an attempt and say whether it may proceed. Call once per request, and
 * only after the caller is known, so an unauthenticated flood cannot consume a
 * real workspace's allowance.
 */
export function checkAssistantRateLimit(
  workspaceId: string,
  now: number = Date.now()
): RateLimitDecision {
  const recent = (hits.get(workspaceId) ?? []).filter(
    (at) => now - at < LONGEST_WINDOW_MS
  );

  for (const window of ASSISTANT_WINDOWS) {
    const inWindow = recent.filter((at) => now - at < window.ms);
    if (inWindow.length >= window.max) {
      // The oldest hit in this window is the one that has to age out.
      const oldest = inWindow[0];
      const waitMs = window.ms - (now - oldest);
      hits.set(workspaceId, recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }
  }

  recent.push(now);
  hits.set(workspaceId, recent);

  // Keep the map from growing without bound on a long-lived instance.
  if (hits.size > 5000) {
    for (const [key, timestamps] of hits) {
      if (timestamps.every((at) => now - at >= LONGEST_WINDOW_MS)) {
        hits.delete(key);
      }
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test seam. Not called from application code. */
export function resetAssistantRateLimit(workspaceId?: string): void {
  if (workspaceId) {
    hits.delete(workspaceId);
    return;
  }
  hits.clear();
}
