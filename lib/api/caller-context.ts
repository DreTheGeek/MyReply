import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiKeyContext } from "@/lib/api-keys";

/**
 * The machine caller a request was let in as, held for the rest of that
 * request.
 *
 * A key is only honoured inside a door: the v1 route wrapper (lib/api/v1.ts)
 * checks the key, its scope and its rate limit, then runs the handler inside
 * this context. The dashboard handlers it delegates to read the caller from
 * here. A key sent straight to a dashboard route finds no context and is
 * treated as no credential at all, so the scope checked at the door cannot be
 * walked around by calling the handler behind it.
 */

const store = new AsyncLocalStorage<ApiKeyContext>();

export function runAsCaller<T>(caller: ApiKeyContext, fn: () => T): T {
  return store.run(caller, fn);
}

export function currentCaller(): ApiKeyContext | null {
  return store.getStore() ?? null;
}
