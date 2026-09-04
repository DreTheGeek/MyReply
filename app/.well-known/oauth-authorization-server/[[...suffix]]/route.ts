import { NextResponse } from "next/server";
import {
  MCP_RESOURCE_PATH,
  endpointsForIssuer,
  resolveIssuer,
} from "@/lib/oauth/config";
import { CORS_HEADERS, corsPreflight } from "@/lib/oauth/errors";
import { SUPPORTED_SCOPES } from "@/lib/oauth/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 8414 Authorization Server Metadata.
 *
 * MyReply is its own authorization server, so the issuer here is the same
 * origin the app is served from. The optional catch-all answers both the plain
 * path and the resource-suffixed one some clients probe first.
 *
 * What this document commits to, and why:
 *   - `code` only. No implicit grant and no password grant, per OAuth 2.1.
 *   - `S256` only. PKCE is required and `plain` is not offered.
 *   - `none` as the only client authentication method: every client here is a
 *     public client, so there is no client secret anywhere in this system.
 *   - RFC 9207, so an authorization response names the server that produced it.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ suffix?: string[] }> }
): Promise<NextResponse> {
  const { suffix } = await context.params;

  if (suffix && suffix.length > 0) {
    const requestedPath = `/${suffix.join("/")}`;
    if (requestedPath !== MCP_RESOURCE_PATH) {
      return NextResponse.json(
        {
          error: "not_found",
          error_description: "No authorization server is published at that path.",
        },
        { status: 404, headers: CORS_HEADERS }
      );
    }
  }

  const endpoints = endpointsForIssuer(resolveIssuer(request));

  return NextResponse.json(
    {
      issuer: endpoints.issuer,
      authorization_endpoint: endpoints.authorizationEndpoint,
      token_endpoint: endpoints.tokenEndpoint,
      registration_endpoint: endpoints.registrationEndpoint,
      revocation_endpoint: endpoints.revocationEndpoint,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    },
    {
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}

export async function OPTIONS(): Promise<NextResponse> {
  return corsPreflight();
}
