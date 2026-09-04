import { NextResponse } from "next/server";
import { registerClient } from "@/lib/oauth/clients";
import {
  CORS_HEADERS,
  NO_STORE_HEADERS,
  corsPreflight,
  oauthErrorResponse,
} from "@/lib/oauth/errors";
import { checkRateLimit, clientAddress } from "@/lib/oauth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dynamic Client Registration, RFC 7591.
 *
 * The MCP specification deprecates this in favour of Client ID Metadata
 * Documents, and both are supported here, but this is the endpoint Claude and
 * ChatGPT actually call today. Removing it would mean nobody could connect.
 *
 * Open and unauthenticated, as RFC 7591 permits: registering says nothing about
 * access. A registered client still has to send a real person through the
 * consent screen before it can read anything, and it never receives a secret.
 */

const REGISTRATIONS_PER_HOUR = 20;

export async function POST(request: Request): Promise<NextResponse> {
  const limit = checkRateLimit(
    `oauth:register:${clientAddress(request)}`,
    REGISTRATIONS_PER_HOUR,
    60 * 60 * 1000
  );

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Too many registrations from this address. Try again shortly.",
      },
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          ...NO_STORE_HEADERS,
          "Retry-After": String(limit.retryAfterSeconds),
        },
      }
    );
  }

  const body: unknown = await request.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    return oauthErrorResponse(
      "invalid_client_metadata",
      "Send a JSON body containing redirect_uris."
    );
  }

  const result = await registerClient(body);
  if (!result.ok) {
    return oauthErrorResponse(result.error, result.description);
  }

  // RFC 7591 wants the registered metadata echoed back. There is no
  // client_secret and no client_secret_expires_at, because this server issues
  // public clients only.
  return NextResponse.json(
    {
      client_id: result.client.clientId,
      client_id_issued_at: result.issuedAt,
      client_name: result.client.clientName,
      redirect_uris: result.client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: result.client.scope,
    },
    { status: 201, headers: { ...CORS_HEADERS, ...NO_STORE_HEADERS } }
  );
}

export async function OPTIONS(): Promise<NextResponse> {
  return corsPreflight();
}
