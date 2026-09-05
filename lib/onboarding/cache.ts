/**
 * A very small, very short-lived cache for onboarding suggestions.
 *
 * Building drafts costs one Graph API call. That is fast, but onboarding is
 * the one screen a new user reloads repeatedly while deciding, and hammering
 * Meta on every reload is how an account meets a rate limit thirty seconds
 * after signing up.
 *
 * Deliberately in-process rather than Redis. The value is cheap to rebuild, it
 * must not survive a deploy, and a per-instance miss costs a single API call.
 * A shared cache here would be more infrastructure than the problem deserves.
 *
 * Ninety seconds is chosen so that someone who posts something new and comes
 * back to look for it does not have to wait meaningfully, while a burst of
 * reloads collapses to one call.
 */

const TTL_MS = 90_000;

/** Cap the map so a long-running instance cannot grow it without bound. */
const MAX_ENTRIES = 200;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

function evictExpired(now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

/**
 * Return the cached value for `key`, or build it, cache it and return it.
 *
 * A rejected build is never cached: a token that failed to refresh once must
 * not lock the screen into a failure for ninety seconds.
 */
export async function withOnboardingCache<T>(
  key: string,
  build: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const value = await build();

  evictExpired(now);
  if (store.size >= MAX_ENTRIES) {
    // Oldest insertion first, which is what Map iteration order gives us.
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { value, expiresAt: now + TTL_MS });

  return value;
}

/**
 * Drop an account's cached suggestions.
 *
 * Called after an activation so the next load does not still offer a draft the
 * user has already turned into a live campaign.
 *
 * Matches on prefix rather than on an exact key, because the same account is
 * cached once per tone. Invalidating only the tone that happened to be active
 * would leave the others still offering the draft that was just activated.
 */
export function invalidateOnboardingCache(keyPrefix: string): void {
  for (const key of store.keys()) {
    if (key === keyPrefix || key.startsWith(`${keyPrefix}:`)) {
      store.delete(key);
    }
  }
}

/** Cache key for one workspace's view of one Instagram account. */
export function onboardingCacheKey(
  workspaceId: string,
  instagramAccountId: string
): string {
  return `${workspaceId}:${instagramAccountId}`;
}

/** Test seam: empties the store so one test cannot leak into the next. */
export function clearOnboardingCache(): void {
  store.clear();
}
