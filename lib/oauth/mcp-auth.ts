import { NextResponse } from "next/server";
import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { resolveApiKey, touchApiKey } from "@/lib/api-keys";
import { mcpToolsForRole } from "@/lib/mcp/tools";
import {
  endpointsForIssuer,
  resolveIssuer,
} from "@/lib/oauth/config";
import {
  CORS_HEADERS,
  buildResourceChallenge,
} from "@/lib/oauth/errors";
import { getMembershipRole } from "@/lib/oauth/membership";
import {
  DEFAULT_SCOPE,
  SCOPE_WRITE,
  narrowRoleForScopes,
  parseScope,
} from "@/lib/oauth/scopes";
import { extractBearerToken, isApiKey } from "@/lib/oauth/secrets";
import { resolveAccessToken, touchAccessToken } from "@/lib/oauth/tokens";

/**
 * One credential type for the MCP route, whichever way the caller authenticated.
 *
 * An OAuth access token and an `mr_live_` API key both land here as a workspace
 * plus a role, so nothing downstream in lib/mcp/tools.ts has to know which one
 * it is talking to. `scopes` is null for an API key, which has no scopes: its
 * role alone decides what it may do, exactly as before.
 */
export interface McpCredential {
  kind: "api_key" | "oauth";
  workspaceId: string;
  role: WorkspaceRole;
  scopes: string[] | null;
}

export type McpAuthResult =
  | { ok: true; credential: McpCredential }
  | { ok: false; response: NextResponse };

/**
 * Tools that need `mcp:write`, derived from the role gate rather than listed
 * again here. Anything a MEMBER is not offered is a write tool, so adding a
 * tool to lib/mcp/tools.ts cannot leave this list behind.
 */
const READ_ONLY_TOOLS = new Set(
  mcpToolsForRole("MEMBER").map((tool) => tool.name)
);

export function toolNeedsWriteScope(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName);
}

function challengeResponse(
  request: Request,
  options: {
    status: number;
    error?: "invalid_token";
    description: string;
  }
): NextResponse {
  const endpoints = endpointsForIssuer(resolveIssuer(request));

  return NextResponse.json(
    {
      error: options.error ?? "unauthorized",
      error_description: options.description,
    },
    {
      status: options.status,
      headers: {
        ...CORS_HEADERS,
        "WWW-Authenticate": buildResourceChallenge({
          resourceMetadataUrl: endpoints.protectedResourceMetadata,
          scope: DEFAULT_SCOPE,
          error: options.error,
          errorDescription: options.error ? options.description : undefined,
        }),
      },
    }
  );
}

/** A 403 that names the scope the client should have asked for. */
export function insufficientScopeResponse(
  request: Request,
  toolName: string
): NextResponse {
  const endpoints = endpointsForIssuer(resolveIssuer(request));

  return NextResponse.json(
    {
      error: "insufficient_scope",
      error_description: `${toolName} changes campaigns, which needs the ${SCOPE_WRITE} scope. Reconnect and approve write access.`,
    },
    {
      status: 403,
      headers: {
        ...CORS_HEADERS,
        "WWW-Authenticate": buildResourceChallenge({
          resourceMetadataUrl: endpoints.protectedResourceMetadata,
          scope: SCOPE_WRITE,
          error: "insufficient_scope",
          errorDescription: `${toolName} needs ${SCOPE_WRITE}.`,
        }),
      },
    }
  );
}

/**
 * Authenticate an MCP request.
 *
 * No credential at all returns a 401 carrying the RFC 9728 challenge rather
 * than a JSON-RPC error, because that header is the whole discovery mechanism:
 * it is what turns "paste a key into a header" into "click Connect".
 */
export async function authenticateMcpRequest(
  request: Request
): Promise<McpAuthResult> {
  const presented = extractBearerToken(request.headers.get("authorization"));

  if (!presented) {
    return {
      ok: false,
      response: challengeResponse(request, {
        status: 401,
        description:
          "Authorization required. Connect with OAuth, or send an API key as: Authorization: Bearer mr_live_...",
      }),
    };
  }

  if (isApiKey(presented)) {
    const context = await resolveApiKey(presented);
    if (!context) {
      return {
        ok: false,
        response: challengeResponse(request, {
          status: 401,
          error: "invalid_token",
          description: "That API key is not valid, or it has been revoked or has expired.",
        }),
      };
    }

    touchApiKey(context.apiKeyId);
    return {
      ok: true,
      credential: {
        kind: "api_key",
        workspaceId: context.workspaceId,
        role: context.role,
        scopes: null,
      },
    };
  }

  const endpoints = endpointsForIssuer(resolveIssuer(request));
  const resolution = await resolveAccessToken(presented, endpoints.resource);

  if (resolution.status === "wrong_audience") {
    return {
      ok: false,
      response: challengeResponse(request, {
        status: 401,
        error: "invalid_token",
        description:
          "That token was issued for a different resource and is not accepted here.",
      }),
    };
  }

  if (resolution.status === "expired") {
    return {
      ok: false,
      response: challengeResponse(request, {
        status: 401,
        error: "invalid_token",
        description: "That access token has expired. Refresh it and try again.",
      }),
    };
  }

  if (resolution.status !== "ok") {
    return {
      ok: false,
      response: challengeResponse(request, {
        status: 401,
        error: "invalid_token",
        description: "That access token is not valid.",
      }),
    };
  }

  // Membership is re-read here, not trusted from the token, so access ends when
  // the person is removed from the workspace rather than when the token lapses.
  const role = await getMembershipRole(
    resolution.token.userId,
    resolution.token.workspaceId
  );

  if (!role) {
    return {
      ok: false,
      response: challengeResponse(request, {
        status: 401,
        error: "invalid_token",
        description:
          "The person who approved this connection is no longer a member of that workspace.",
      }),
    };
  }

  touchAccessToken(resolution.token.id);

  const scopes = parseScope(resolution.token.scope);
  return {
    ok: true,
    credential: {
      kind: "oauth",
      workspaceId: resolution.token.workspaceId,
      // Scope narrows the live role and can never widen it.
      role: narrowRoleForScopes(role, scopes),
      scopes,
    },
  };
}
