import { NextResponse } from "next/server";
import { getRequestApiKeyContext } from "@/lib/auth";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

/**
 * Shared plumbing for the public v1 API.
 *
 * v1 deliberately wraps the same handlers the dashboard uses rather than
 * reimplementing them. Two copies of campaign validation would drift, and the
 * drift would show up as an agent creating a campaign the UI considers invalid.
 * The wrappers exist to pin a stable URL and to reject session cookies, not to
 * add behaviour.
 */

export interface V1Caller {
  workspaceId: string;
  /** Present for a key-authenticated call, absent for a session. */
  apiKeyId?: string;
}

/**
 * Require an API key specifically, not merely "some authentication".
 *
 * A browser session must not reach v1: cookies travel automatically, so a
 * logged-in user visiting a malicious page could otherwise have their browser
 * make authenticated v1 calls. Keys are sent deliberately by a program, which
 * is the whole audience for this surface.
 */
export async function requireApiKey(): Promise<V1Caller | NextResponse> {
  const context = await getRequestApiKeyContext();

  if (!context) {
    return NextResponse.json(
      {
        success: false,
        error:
          "This endpoint requires an API key. Send it as: Authorization: Bearer mr_live_...",
      },
      { status: 401 }
    );
  }

  return { workspaceId: context.workspaceId, apiKeyId: context.apiKeyId };
}

/** True when requireApiKey returned a rejection rather than a caller. */
export function isRejection(
  value: V1Caller | NextResponse
): value is NextResponse {
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

export function v1Error(message: string, status = 400): NextResponse {
  return NextResponse.json({ success: false, error: message }, { status });
}
