import {
  ClientResolutionError,
  type OAuthClientRecord,
  matchRedirectUri,
  resolveClient,
} from "@/lib/oauth/clients";
import { endpointsForIssuer, isThisResource } from "@/lib/oauth/config";
import { buildErrorRedirect } from "@/lib/oauth/errors";
import { CODE_CHALLENGE_METHOD, isValidCodeChallenge } from "@/lib/oauth/pkce";
import {
  DEFAULT_SCOPE,
  intersectScopes,
  isSupportedScope,
  parseScope,
  serializeScope,
} from "@/lib/oauth/scopes";

/**
 * Validating an authorization request, kept apart from the page that renders
 * it so the rules can be read and tested on their own.
 *
 * The order matters and is the security-relevant part. Until the redirect_uri
 * has been matched exactly against the client's registered set, nothing is
 * allowed to redirect: an error about an unknown client or an unregistered
 * redirect_uri is shown on our own page. Redirecting before that check is how
 * an authorization server becomes an open redirect.
 */

export interface ValidatedAuthorizationRequest {
  client: OAuthClientRecord;
  redirectUri: string;
  scopes: string[];
  resource: string;
  /** Passed through to the client untouched, or absent. */
  state: string | null;
  codeChallenge: string;
}

export type AuthorizationRequestOutcome =
  /** Show the consent screen. */
  | { kind: "consent"; request: ValidatedAuthorizationRequest }
  /** Something is wrong that must not be reported by redirecting. */
  | { kind: "error_page"; title: string; detail: string }
  /** A recoverable protocol error the client should be told about. */
  | { kind: "redirect"; url: string };

export type AuthorizeParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export async function validateAuthorizationRequest(
  params: AuthorizeParams,
  issuer: string
): Promise<AuthorizationRequestOutcome> {
  const clientId = single(params.client_id);
  const requestedRedirect = single(params.redirect_uri);
  const state = single(params.state) ?? null;

  if (!clientId) {
    return {
      kind: "error_page",
      title: "This connection request is incomplete",
      detail:
        "The app that sent you here did not say who it is. Nothing has been shared. Go back and start the connection again from the app.",
    };
  }

  let client: OAuthClientRecord | null;
  try {
    client = await resolveClient(clientId);
  } catch (error) {
    return {
      kind: "error_page",
      title: "This app could not be verified",
      detail:
        error instanceof ClientResolutionError
          ? error.message
          : "The app's identity document could not be read.",
    };
  }

  if (!client) {
    return {
      kind: "error_page",
      title: "This app is not registered",
      detail:
        "MyReply has no record of the app that sent you here. Nothing has been shared. Start the connection again from the app.",
    };
  }

  if (!requestedRedirect) {
    return {
      kind: "error_page",
      title: "This connection request is incomplete",
      detail:
        "The app did not say where to send you back to, so there is nowhere safe to return you. Start the connection again from the app.",
    };
  }

  // Exact match, byte for byte. A registered https://app.example/cb does not
  // cover https://app.example/cb.attacker.test or https://app.example/cb/more.
  const redirectUri = matchRedirectUri(client.redirectUris, requestedRedirect);
  if (!redirectUri) {
    return {
      kind: "error_page",
      title: "That return address is not registered",
      detail: `${client.clientName} asked to be sent back to an address it has not registered with MyReply. This is what an interception attempt looks like, so nothing has been shared.`,
    };
  }

  // From here on the redirect_uri is known good, so protocol errors go back to
  // the client where its own error handling can deal with them.
  const redirectWithError = (
    error: Parameters<typeof buildErrorRedirect>[0]["error"],
    description: string
  ): AuthorizationRequestOutcome => ({
    kind: "redirect",
    url: buildErrorRedirect({
      redirectUri,
      error,
      description,
      state,
      issuer,
    }),
  });

  const responseType = single(params.response_type);
  if (responseType !== "code") {
    return redirectWithError(
      "unsupported_response_type",
      "This server issues authorization codes only. Send response_type=code."
    );
  }

  const codeChallenge = single(params.code_challenge);
  const codeChallengeMethod = single(params.code_challenge_method);

  if (!codeChallenge) {
    return redirectWithError(
      "invalid_request",
      "PKCE is required. Send a code_challenge with code_challenge_method=S256."
    );
  }

  if (codeChallengeMethod !== CODE_CHALLENGE_METHOD) {
    return redirectWithError(
      "invalid_request",
      "code_challenge_method must be S256. The plain method is not accepted."
    );
  }

  if (!isValidCodeChallenge(codeChallenge)) {
    return redirectWithError(
      "invalid_request",
      "code_challenge is not a valid base64url S256 challenge."
    );
  }

  const allowed = parseScope(client.scope);
  const requestedScopes = parseScope(single(params.scope));
  const scopes =
    requestedScopes.length > 0
      ? intersectScopes(requestedScopes, allowed)
      : intersectScopes(parseScope(DEFAULT_SCOPE), allowed);

  if (requestedScopes.length > 0) {
    const unknown = requestedScopes.filter((scope) => !isSupportedScope(scope));
    if (unknown.length > 0) {
      return redirectWithError(
        "invalid_scope",
        `This server has no scope called ${unknown.join(", ")}. It offers ${serializeScope(
          allowed
        )}.`
      );
    }
  }

  if (scopes.length === 0) {
    return redirectWithError(
      "invalid_scope",
      "None of the requested scopes are available to this client."
    );
  }

  // RFC 8707. A resource naming a different server is refused outright rather
  // than quietly rewritten, so a client never believes it holds a token for
  // somewhere else. A request with no resource is bound to this server, which
  // keeps every token audience-bound whether the client asked or not.
  const endpoints = endpointsForIssuer(issuer);
  const requestedResource = single(params.resource);
  if (requestedResource && !isThisResource(requestedResource, issuer)) {
    return redirectWithError(
      "invalid_target",
      `This authorization server only issues tokens for ${endpoints.resource}.`
    );
  }

  return {
    kind: "consent",
    request: {
      client,
      redirectUri,
      scopes,
      resource: endpoints.resource,
      state,
      codeChallenge,
    },
  };
}
