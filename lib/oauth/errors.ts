import { NextResponse } from "next/server";

/**
 * OAuth error shapes, in one place so a route cannot invent its own.
 *
 * Two audiences: a machine reading `error` from a JSON body or a redirect query
 * string, and a person reading `error_description`. Descriptions say what to do
 * about it and never repeat anything secret back.
 */

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_target"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "access_denied"
  | "server_error"
  | "invalid_client_metadata"
  | "invalid_token"
  | "insufficient_scope";

const STATUS_BY_CODE: Partial<Record<OAuthErrorCode, number>> = {
  invalid_client: 401,
  invalid_token: 401,
  insufficient_scope: 403,
  access_denied: 403,
  server_error: 500,
};

/** Headers that keep a token response out of every cache between here and there. */
export const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

/**
 * CORS for the endpoints a browser-based MCP client calls directly.
 *
 * These carry no cookies and no ambient authority: registration is open by
 * design, and the token endpoint authenticates with a code plus a PKCE verifier
 * that only the client holds. WWW-Authenticate is exposed because it is the
 * header that teaches a client where the authorization server is.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export function oauthErrorResponse(
  code: OAuthErrorCode,
  description: string,
  extraHeaders: Record<string, string> = {}
): NextResponse {
  return NextResponse.json(
    { error: code, error_description: description },
    {
      status: STATUS_BY_CODE[code] ?? 400,
      headers: { ...NO_STORE_HEADERS, ...CORS_HEADERS, ...extraHeaders },
    }
  );
}

function quote(value: string): string {
  // A quoted-string in an auth-param cannot contain a raw quote or backslash.
  return value.replace(/[\\"]/g, "");
}

/**
 * The challenge that makes OAuth discoverable.
 *
 * A client that gets a 401 from the MCP endpoint reads `resource_metadata`,
 * fetches that document, finds the authorization server and starts the flow.
 * Without this header there is nothing to follow and the user is back to
 * pasting an API key.
 */
export function buildResourceChallenge(options: {
  resourceMetadataUrl: string;
  scope?: string;
  error?: "invalid_token" | "insufficient_scope";
  errorDescription?: string;
}): string {
  const parts: string[] = [
    `resource_metadata="${quote(options.resourceMetadataUrl)}"`,
  ];

  if (options.error) {
    parts.unshift(`error="${options.error}"`);
    if (options.errorDescription) {
      parts.push(`error_description="${quote(options.errorDescription)}"`);
    }
  }

  if (options.scope) {
    parts.push(`scope="${quote(options.scope)}"`);
  }

  return `Bearer ${parts.join(", ")}`;
}

/**
 * Build a redirect back to the client carrying an error.
 *
 * Only ever called once the redirect_uri has been matched exactly against the
 * client's registered set. Before that point an error is rendered instead, so a
 * bad redirect_uri can never turn this server into an open redirect.
 */
export function buildErrorRedirect(options: {
  redirectUri: string;
  error: OAuthErrorCode;
  description: string;
  state: string | null;
  issuer: string;
}): string {
  const url = new URL(options.redirectUri);
  url.searchParams.set("error", options.error);
  url.searchParams.set("error_description", options.description);
  if (options.state !== null) {
    url.searchParams.set("state", options.state);
  }
  // RFC 9207. Tells the client which authorization server answered, so a
  // response cannot be replayed into a different server's callback.
  url.searchParams.set("iss", options.issuer);
  return url.toString();
}
