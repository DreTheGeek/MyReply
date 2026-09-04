/**
 * Where this authorization server lives, and what it calls itself.
 *
 * MyReply is both the resource server and the authorization server. The issuer
 * is the deployment's own origin, so a self-hoster gets a working OAuth server
 * without configuring anything beyond NEXTAUTH_URL, which they already set for
 * sign-in links.
 */

/** Everything an MCP client needs to find, all derived from one origin. */
export interface OAuthEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
  resource: string;
  protectedResourceMetadata: string;
  authorizationServerMetadata: string;
}

/** The MCP endpoint's path. Also the audience every token is bound to. */
export const MCP_RESOURCE_PATH = "/api/mcp";

/** The consent screen. This is the OAuth authorization endpoint itself. */
export const AUTHORIZE_PATH = "/oauth/authorize";

/** Where the consent screen's Approve and Deny buttons post to. */
export const DECISION_PATH = "/api/oauth/decision";

export const TOKEN_PATH = "/api/oauth/token";
export const REGISTRATION_PATH = "/api/oauth/register";
export const REVOCATION_PATH = "/api/oauth/revoke";

/** Short enough that a leaked code in a log or a Referer header is already dead. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a signed consent request stays valid while the user reads it. */
export const CONSENT_REQUEST_TTL_MS = 10 * 60 * 1000;

/** How long a fetched Client ID Metadata Document is trusted before a re-read. */
export const CLIENT_METADATA_TTL_MS = 60 * 60 * 1000;

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * The origin this server answers on.
 *
 * NEXTAUTH_URL wins when it is set, because it is the one value the operator
 * has already declared to be the canonical URL, and it cannot be moved by a
 * forged Host header. The header fallback exists so a fresh local checkout with
 * no env file still serves coherent metadata.
 */
export function resolveIssuerFromHeaders(
  headerList: Headers,
  fallbackUrl?: string
): string {
  const configured = process.env.NEXTAUTH_URL;
  if (configured) return stripTrailingSlash(configured);

  const forwardedHost = headerList.get("x-forwarded-host");
  const host = forwardedHost ?? headerList.get("host");
  if (host) {
    const proto = headerList.get("x-forwarded-proto") ?? "https";
    return stripTrailingSlash(`${proto}://${host}`);
  }

  if (fallbackUrl) {
    const url = new URL(fallbackUrl);
    return stripTrailingSlash(url.origin);
  }

  return "http://localhost:3000";
}

export function resolveIssuer(request: Request): string {
  return resolveIssuerFromHeaders(request.headers, request.url);
}

export function endpointsForIssuer(issuer: string): OAuthEndpoints {
  const base = stripTrailingSlash(issuer);
  const resource = `${base}${MCP_RESOURCE_PATH}`;

  return {
    issuer: base,
    authorizationEndpoint: `${base}${AUTHORIZE_PATH}`,
    tokenEndpoint: `${base}${TOKEN_PATH}`,
    registrationEndpoint: `${base}${REGISTRATION_PATH}`,
    revocationEndpoint: `${base}${REVOCATION_PATH}`,
    resource,
    // RFC 9728 puts the resource's path after the well-known segment, so a host
    // serving several resources can describe each one separately.
    protectedResourceMetadata: `${base}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`,
    authorizationServerMetadata: `${base}/.well-known/oauth-authorization-server`,
  };
}

/**
 * Reduce a resource indicator to a single comparable form.
 *
 * RFC 8707 says a resource is an absolute URI with no fragment. Scheme and host
 * are case insensitive and a default port means the same thing as no port, so
 * those are normalised away. A trailing slash is dropped for the same reason.
 * Returns null for anything that is not a usable resource indicator, so the
 * caller refuses rather than guessing.
 */
export function canonicalizeResource(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.hash !== "") return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const path = url.pathname === "/" ? "" : stripTrailingSlash(url.pathname);
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * True when a requested resource names this MCP server.
 *
 * This is the single definition of "our audience". Both the authorization
 * request and the token request run through it, and the MCP route compares a
 * presented token's stored resource against the same canonical value.
 */
export function isThisResource(requested: string, issuer: string): boolean {
  const canonical = canonicalizeResource(requested);
  if (!canonical) return false;
  return canonical === canonicalizeResource(endpointsForIssuer(issuer).resource);
}
