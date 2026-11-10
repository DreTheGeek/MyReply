import { NextResponse, type NextRequest } from "next/server";
import type { ApiKeyContext } from "@/lib/api-keys";
import { runAsCaller } from "@/lib/api/caller-context";
import { withIdempotency } from "@/lib/api/idempotency";
import { consumeCredentialRequest, rateLimitRefusal } from "@/lib/api/rate-limit";
import { hasScope, type ApiScope } from "@/lib/api/scopes";
import {
  requestCarriesPartnerKey,
  resolveRequestApiKey,
  resolveRequestPartner,
} from "@/lib/auth";
import type { PartnerCaller } from "@/lib/partners/keys";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

/**
 * Shared plumbing for the public v1 API.
 *
 * v1 deliberately wraps the same handlers the dashboard uses rather than
 * reimplementing them. Two copies of campaign validation would drift, and the
 * drift would show up as an agent creating a campaign the UI considers invalid.
 * The wrapper pins a stable URL, refuses session cookies, checks the scope and
 * the rate limit, and turns anything unexpected into a clean 500.
 */

export type V1Caller = ApiKeyContext;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function v1Error(message: string, status = 400, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(
    { success: false, error: message },
    { status, headers: { ...NO_STORE, ...headers } }
  );
}

export function v1Data(data: unknown, status = 200, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(
    { success: true, data },
    { status, headers: { ...NO_STORE, ...headers } }
  );
}

/**
 * Require an API key specifically, not merely "some authentication", with the
 * scope this endpoint needs.
 *
 * A browser session must not reach v1: cookies travel automatically, so a
 * logged-in user visiting a malicious page could otherwise have their browser
 * make authenticated v1 calls. Keys are sent deliberately by a program, which
 * is the whole audience for this surface.
 */
export async function requireApiKey(scope?: ApiScope): Promise<V1Caller | NextResponse> {
  const context = await resolveRequestApiKey();

  if (!context) {
    // A valid partner key that named no workspace, or one that is not its
    // own. Unknown and someone else's read the same, so ids cannot be probed.
    if (await requestCarriesPartnerKey()) {
      const partner = await resolveRequestPartner();
      if (partner) {
        return v1Error(
          "Name one of your workspaces in the X-Workspace-Id header. That workspace was not found for this key.",
          404
        );
      }
    }
    return v1Error(
      "This endpoint requires an API key. Send it as: Authorization: Bearer mr_live_...",
      401
    );
  }

  // Counted once, here, at the one door every v1 handler goes through. The
  // handlers it delegates to read the caller from the door's context and never
  // count again.
  const decision = await consumeCredentialRequest(context.credentialId);
  if (decision.status !== "allowed") {
    const refusal = rateLimitRefusal(decision);
    return v1Error(refusal.message, refusal.status, refusal.headers);
  }

  if (scope && !hasScope(context.scopes, scope)) {
    return v1Error(`This key does not have the ${scope} scope.`, 403);
  }

  return context;
}

/** True when requireApiKey returned a rejection rather than a caller. */
export function isRejection(value: V1Caller | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}

/**
 * Resolve the workspace for a v1 call. Exposed so a route can name the tenant
 * in its own queries without repeating the key lookup.
 */
export async function v1Workspace(): Promise<string | null> {
  const context = await getCurrentWorkspaceContext();
  return context?.workspaceId ?? null;
}

type RouteContext<P> = { params: Promise<P> };

export type V1Handler<P> = (
  request: NextRequest,
  caller: V1Caller,
  params: P
) => Promise<Response>;

/**
 * A v1 route: the key, the scope and the limit checked at the door, then the
 * handler run as that caller, so anything it delegates to sees the same key.
 *
 * Nothing internal reaches the client. A thrown error is logged here with the
 * route and answered with a plain 500.
 */
export interface V1RouteOptions {
  /** Refuse a write without an Idempotency-Key, where a duplicate does harm. */
  requireIdempotencyKey?: boolean;
}

export function v1Route<P = Record<string, never>>(
  scope: ApiScope | null,
  handler: V1Handler<P>,
  options: V1RouteOptions = {}
): (request: NextRequest, context: RouteContext<P>) => Promise<Response> {
  return async (request, context) => {
    const caller = await requireApiKey(scope ?? undefined);
    if (isRejection(caller)) return caller;

    try {
      const params = context?.params ? await context.params : ({} as P);
      // Every write takes an Idempotency-Key, keyed to this credential.
      return await withIdempotency(
        request,
        caller.credentialId,
        (replayable) => runAsCaller(caller, () => handler(replayable, caller, params)),
        { required: options.requireIdempotencyKey }
      );
    } catch (error) {
      console.error(
        `[v1] ${request.method} ${request.nextUrl.pathname} failed:`,
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown"
      );
      return v1Error("Something went wrong on our side. Try again shortly.", 500);
    }
  };
}

export type PartnerHandler<P> = (
  request: NextRequest,
  partner: PartnerCaller,
  params: P
) => Promise<Response>;

/**
 * A partner's own endpoint: making, listing and removing its workspaces. Only
 * a partner key gets in; a workspace key is refused, because a workspace has
 * no business creating other workspaces.
 */
export function partnerRoute<P = Record<string, never>>(
  scope: ApiScope,
  handler: PartnerHandler<P>
): (request: NextRequest, context: RouteContext<P>) => Promise<Response> {
  return async (request, context) => {
    const partner = await resolveRequestPartner();
    if (!partner) {
      return v1Error(
        "This endpoint requires a partner key. Send it as: Authorization: Bearer mr_partner_...",
        401
      );
    }

    const decision = await consumeCredentialRequest(partner.credentialId);
    if (decision.status !== "allowed") {
      const refusal = rateLimitRefusal(decision);
      return v1Error(refusal.message, refusal.status, refusal.headers);
    }

    if (!hasScope(partner.scopes, scope)) {
      return v1Error(`This key does not have the ${scope} scope.`, 403);
    }

    try {
      const params = context?.params ? await context.params : ({} as P);
      return await withIdempotency(request, partner.credentialId, (replayable) =>
        handler(replayable, partner, params)
      );
    } catch (error) {
      console.error(
        `[v1] ${request.method} ${request.nextUrl.pathname} failed:`,
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown"
      );
      return v1Error("Something went wrong on our side. Try again shortly.", 500);
    }
  };
}
