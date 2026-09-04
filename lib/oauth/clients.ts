import { randomBytes } from "crypto";
import { z } from "zod";
import type { OAuthClientRegistration } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { SsrfError, safeFetch } from "@/lib/knowledge/ssrf";
import { CLIENT_METADATA_TTL_MS } from "@/lib/oauth/config";
import {
  DEFAULT_SCOPE,
  isSupportedScope,
  parseScope,
  serializeScope,
} from "@/lib/oauth/scopes";

/**
 * Who is allowed to ask a MyReply user for access.
 *
 * Two ways in, because the ecosystem is mid-migration:
 *
 *   1. Dynamic Client Registration, RFC 7591. Deprecated by the MCP spec but
 *      it is what Claude and ChatGPT actually do today, so it has to work.
 *   2. Client ID Metadata Documents, where the client_id is an https URL and
 *      the document at that URL is the registration. Nothing is stored on our
 *      side except a cache, and the client operator can change their redirect
 *      URIs by editing their own file.
 *
 * Every client here is a public client. No client secret is issued, stored or
 * accepted, so there is nothing to leak: PKCE is what proves the caller
 * redeeming a code is the one that started the flow.
 */

export interface OAuthClientRecord {
  /** Our row id, used as the foreign key on codes and tokens. */
  id: string;
  /** The public identifier the client sends. */
  clientId: string;
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
  /** The most this client may be granted, space separated. */
  scope: string;
  registration: OAuthClientRegistration;
}

/** Schemes that must never appear in a redirect_uri, whatever else is allowed. */
const DANGEROUS_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * A redirect_uri this server is willing to send a browser to.
 *
 * https anywhere, http only for loopback (a native client listening on a
 * throwaway port), and private-use schemes such as `cursor://` or
 * `com.example.app:/cb` for desktop and mobile clients. A fragment is refused
 * outright because the authorization response is appended as a query and a
 * fragment would silently swallow it.
 *
 * This decides what may be *registered*. What is *used* still has to match a
 * registered string exactly, which is the check that stops open redirects.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (DANGEROUS_SCHEMES.has(url.protocol)) return false;
  if (url.hash !== "" || raw.includes("#")) return false;
  if (raw.includes("*")) return false;

  if (url.protocol === "https:") return url.hostname.length > 0;

  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  }

  // Anything else is a private-use scheme. Require it to look like one rather
  // than accepting whatever the URL parser tolerated.
  return /^[a-z][a-z0-9+\-.]*:$/i.test(url.protocol);
}

/**
 * The registered redirect_uri equal to the requested one, or null.
 *
 * Byte-for-byte equality on purpose. Prefix matching is the classic way this
 * goes wrong: a client registered at https://good.example/cb would otherwise
 * accept https://good.example/cb.attacker.test, and the code would be handed
 * to whoever asked.
 */
export function matchRedirectUri(
  registered: readonly string[],
  requested: string
): string | null {
  for (const candidate of registered) {
    if (candidate === requested) return candidate;
  }
  return null;
}

/** The host a user will actually be sent back to, for the consent screen. */
export function redirectHost(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    return url.host || url.protocol.replace(":", "");
  } catch {
    return redirectUri;
  }
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(120).optional(),
  client_uri: z.string().trim().max(2000).optional(),
  logo_uri: z.string().trim().max(2000).optional(),
  scope: z.string().trim().max(200).optional(),
  grant_types: z.array(z.string().max(80)).max(10).optional(),
  response_types: z.array(z.string().max(80)).max(10).optional(),
  token_endpoint_auth_method: z.string().trim().max(80).optional(),
});

export type ClientRegistrationInput = z.infer<typeof registrationSchema>;

export type RegistrationResult =
  | { ok: true; client: OAuthClientRecord; issuedAt: number }
  | { ok: false; error: "invalid_client_metadata" | "invalid_request"; description: string };

const SUPPORTED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

function sanitizeScopeRequest(requested: string | undefined): string {
  if (!requested) return DEFAULT_SCOPE;
  const wanted = parseScope(requested).filter(isSupportedScope);
  return wanted.length > 0 ? serializeScope(wanted) : DEFAULT_SCOPE;
}

/** Dynamic Client Registration, RFC 7591. Open, unauthenticated, public clients only. */
export async function registerClient(body: unknown): Promise<RegistrationResult> {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description:
        "redirect_uris is required and must be an array of one to ten absolute URIs.",
    };
  }

  const input = parsed.data;

  for (const uri of input.redirect_uris) {
    if (!isAllowedRedirectUri(uri)) {
      return {
        ok: false,
        error: "invalid_client_metadata",
        description: `${uri} is not an acceptable redirect_uri. Use https, http on loopback, or a private-use scheme, and no fragment or wildcard.`,
      };
    }
  }

  const grantTypes = input.grant_types ?? ["authorization_code", "refresh_token"];
  for (const grant of grantTypes) {
    if (!SUPPORTED_GRANT_TYPES.has(grant)) {
      return {
        ok: false,
        error: "invalid_client_metadata",
        description: `This server supports authorization_code and refresh_token only, not ${grant}.`,
      };
    }
  }

  const responseTypes = input.response_types ?? ["code"];
  for (const responseType of responseTypes) {
    if (responseType !== "code") {
      return {
        ok: false,
        error: "invalid_client_metadata",
        description: `This server supports response_type=code only, not ${responseType}.`,
      };
    }
  }

  const authMethod = input.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description:
        "This server registers public clients only. Send token_endpoint_auth_method=none and use PKCE.",
    };
  }

  const clientId = `mrc_${randomBytes(16).toString("base64url")}`;
  const created = await prisma.oAuthClient.create({
    data: {
      clientId,
      registration: "DYNAMIC",
      clientName: input.client_name ?? "Unnamed MCP client",
      clientUri: input.client_uri ?? null,
      logoUri: input.logo_uri ?? null,
      redirectUris: input.redirect_uris,
      scope: sanitizeScopeRequest(input.scope),
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod: "none",
    },
    select: {
      id: true,
      clientId: true,
      clientName: true,
      clientUri: true,
      redirectUris: true,
      scope: true,
      registration: true,
      createdAt: true,
    },
  });

  return {
    ok: true,
    client: {
      id: created.id,
      clientId: created.clientId,
      clientName: created.clientName,
      clientUri: created.clientUri,
      redirectUris: created.redirectUris,
      scope: created.scope,
      registration: created.registration,
    },
    issuedAt: Math.floor(created.createdAt.getTime() / 1000),
  };
}

const metadataDocumentSchema = z.object({
  client_id: z.string().min(1),
  client_name: z.string().trim().min(1).max(120).optional(),
  client_uri: z.string().trim().max(2000).optional(),
  logo_uri: z.string().trim().max(2000).optional(),
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(10),
  scope: z.string().trim().max(200).optional(),
  grant_types: z.array(z.string().max(80)).max(10).optional(),
  response_types: z.array(z.string().max(80)).max(10).optional(),
  token_endpoint_auth_method: z.string().trim().max(80).optional(),
});

export function isClientIdMetadataUrl(clientId: string): boolean {
  return clientId.startsWith("https://");
}

export class ClientResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientResolutionError";
  }
}

/**
 * Read and validate a Client ID Metadata Document.
 *
 * The URL comes from whoever is starting the flow, so this is an outbound
 * request to an address a stranger chose. It goes through the crawler's SSRF
 * guard, which refuses private and link-local space and re-checks every
 * redirect hop, rather than through a second implementation of the same rules.
 */
async function fetchClientMetadata(clientId: string): Promise<OAuthClientRecord> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientResolutionError("client_id is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new ClientResolutionError(
      "A client_id URL must use https so the document cannot be rewritten in transit."
    );
  }
  if (url.hash !== "") {
    throw new ClientResolutionError("A client_id URL must not contain a fragment.");
  }

  let body: string;
  try {
    const response = await safeFetch(clientId, {
      accept: "application/json",
      userAgent: "MyReplyOAuth/1.0 (+https://myreply.app/bot)",
      timeoutMs: 5_000,
      maxRedirects: 2,
      maxBytes: 64_000,
    });

    if (response.status !== 200) {
      throw new ClientResolutionError(
        `The client_id URL answered ${response.status} rather than serving a metadata document.`
      );
    }

    body = new TextDecoder().decode(response.bytes);
  } catch (error) {
    if (error instanceof ClientResolutionError) throw error;
    if (error instanceof SsrfError) {
      throw new ClientResolutionError(error.message);
    }
    throw new ClientResolutionError("The client_id URL could not be read.");
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ClientResolutionError("The client_id URL did not return JSON.");
  }

  const parsed = metadataDocumentSchema.safeParse(json);
  if (!parsed.success) {
    throw new ClientResolutionError(
      "The metadata document needs a client_id and at least one redirect_uris entry."
    );
  }

  const document = parsed.data;

  // The document must claim the exact URL it was served from. Without this a
  // client could host a document that impersonates somebody else's client_id.
  if (document.client_id !== clientId) {
    throw new ClientResolutionError(
      "The metadata document's client_id does not match the URL it was fetched from."
    );
  }

  for (const uri of document.redirect_uris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new ClientResolutionError(
        `${uri} is not an acceptable redirect_uri for a client_id metadata document.`
      );
    }

    // A redirect must belong to the same site as the document, or be loopback.
    // The document is the only thing vouching for the client, so letting it
    // name an unrelated host would make it a redirector for that host.
    let target: URL;
    try {
      target = new URL(uri);
    } catch {
      throw new ClientResolutionError(`${uri} is not a valid redirect_uri.`);
    }

    const isLoopback =
      target.protocol === "http:" &&
      LOOPBACK_HOSTS.has(target.hostname.toLowerCase());
    const sameHost = target.hostname.toLowerCase() === url.hostname.toLowerCase();

    if (!isLoopback && !sameHost) {
      throw new ClientResolutionError(
        `${uri} is on a different host to the client_id document, which is not accepted.`
      );
    }
  }

  const scope = sanitizeScopeRequest(document.scope);
  const clientName = document.client_name ?? url.hostname;

  const stored = await prisma.oAuthClient.upsert({
    where: { clientId },
    create: {
      clientId,
      registration: "METADATA_DOCUMENT",
      clientName,
      clientUri: document.client_uri ?? clientId,
      logoUri: document.logo_uri ?? null,
      redirectUris: document.redirect_uris,
      scope,
      grantTypes: document.grant_types ?? ["authorization_code", "refresh_token"],
      responseTypes: document.response_types ?? ["code"],
      tokenEndpointAuthMethod: "none",
      metadataFetchedAt: new Date(),
    },
    update: {
      clientName,
      clientUri: document.client_uri ?? clientId,
      logoUri: document.logo_uri ?? null,
      redirectUris: document.redirect_uris,
      scope,
      metadataFetchedAt: new Date(),
    },
    select: {
      id: true,
      clientId: true,
      clientName: true,
      clientUri: true,
      redirectUris: true,
      scope: true,
      registration: true,
    },
  });

  return stored;
}

/**
 * Find the client behind a client_id, whichever way it was established.
 *
 * Returns null when there is no such client, and throws ClientResolutionError
 * when a metadata document exists but is unusable, so the authorization
 * endpoint can tell the user which of the two happened.
 */
export async function resolveClient(
  clientId: string
): Promise<OAuthClientRecord | null> {
  const existing = await prisma.oAuthClient.findUnique({
    where: { clientId },
    select: {
      id: true,
      clientId: true,
      clientName: true,
      clientUri: true,
      redirectUris: true,
      scope: true,
      registration: true,
      metadataFetchedAt: true,
      disabledAt: true,
    },
  });

  if (existing?.disabledAt) return null;

  if (!isClientIdMetadataUrl(clientId)) {
    if (!existing) return null;
    return {
      id: existing.id,
      clientId: existing.clientId,
      clientName: existing.clientName,
      clientUri: existing.clientUri,
      redirectUris: existing.redirectUris,
      scope: existing.scope,
      registration: existing.registration,
    };
  }

  // A cached document is trusted for an hour, so a consent screen does not
  // make an outbound request on every page load, and a client that changes its
  // redirect URIs sees the change take effect within the hour.
  const fetchedAt = existing?.metadataFetchedAt?.getTime() ?? 0;
  if (existing && Date.now() - fetchedAt < CLIENT_METADATA_TTL_MS) {
    return {
      id: existing.id,
      clientId: existing.clientId,
      clientName: existing.clientName,
      clientUri: existing.clientUri,
      redirectUris: existing.redirectUris,
      scope: existing.scope,
      registration: existing.registration,
    };
  }

  return fetchClientMetadata(clientId);
}
