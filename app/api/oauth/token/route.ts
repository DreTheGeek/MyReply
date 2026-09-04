import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveClient } from "@/lib/oauth/clients";
import { redeemAuthorizationCode } from "@/lib/oauth/codes";
import { canonicalizeResource } from "@/lib/oauth/config";
import {
  CORS_HEADERS,
  NO_STORE_HEADERS,
  corsPreflight,
  oauthErrorResponse,
} from "@/lib/oauth/errors";
import { getMembershipRole } from "@/lib/oauth/membership";
import { verifyCodeVerifier } from "@/lib/oauth/pkce";
import { checkRateLimit, clientAddress } from "@/lib/oauth/rate-limit";
import { parseScope, serializeScope } from "@/lib/oauth/scopes";
import { consumeRefreshToken, issueTokenPair } from "@/lib/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The token endpoint. Authorization code with PKCE, and rotating refresh
 * tokens.
 *
 * No client authentication: every client is public, and possession of the PKCE
 * verifier that matches the challenge recorded at consent time is what proves
 * the caller is the one that started the flow.
 */

const TOKEN_REQUESTS_PER_MINUTE = 60;

const tokenRequestSchema = z.object({
  grant_type: z.string().min(1),
  code: z.string().min(1).max(500).optional(),
  redirect_uri: z.string().min(1).max(2000).optional(),
  client_id: z.string().min(1).max(2000).optional(),
  code_verifier: z.string().min(1).max(256).optional(),
  refresh_token: z.string().min(1).max(500).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(2000).optional(),
});

/** Accepts form encoding, which is the standard, and JSON, which some clients send. */
async function readRequestBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const parsed: unknown = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== "object") return {};

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  const text = await request.text().catch(() => "");
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

function tokenResponse(payload: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}): NextResponse {
  return NextResponse.json(
    {
      access_token: payload.accessToken,
      token_type: "Bearer",
      expires_in: payload.expiresIn,
      refresh_token: payload.refreshToken,
      scope: payload.scope,
    },
    { headers: { ...CORS_HEADERS, ...NO_STORE_HEADERS } }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const limit = checkRateLimit(
    `oauth:token:${clientAddress(request)}`,
    TOKEN_REQUESTS_PER_MINUTE,
    60 * 1000
  );

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Too many token requests from this address.",
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

  const parsed = tokenRequestSchema.safeParse(await readRequestBody(request));
  if (!parsed.success) {
    return oauthErrorResponse("invalid_request", "grant_type is required.");
  }

  const body = parsed.data;

  if (!body.client_id) {
    return oauthErrorResponse("invalid_client", "client_id is required.");
  }

  const client = await resolveClient(body.client_id).catch(() => null);
  if (!client) {
    return oauthErrorResponse("invalid_client", "Unknown client_id.");
  }

  if (body.grant_type === "authorization_code") {
    if (!body.code) {
      return oauthErrorResponse("invalid_request", "code is required.");
    }
    if (!body.redirect_uri) {
      return oauthErrorResponse("invalid_request", "redirect_uri is required.");
    }
    // PKCE is not optional. A client that omits the verifier is refused rather
    // than falling back to a flow with no proof of possession.
    if (!body.code_verifier) {
      return oauthErrorResponse(
        "invalid_request",
        "code_verifier is required. This server requires PKCE with S256."
      );
    }

    const redemption = await redeemAuthorizationCode(body.code);

    if (redemption.status === "replayed") {
      // The first redemption's tokens have just been revoked. Saying only
      // invalid_grant is deliberate: the client learns nothing about whether
      // the code existed or how many tokens were killed.
      return oauthErrorResponse(
        "invalid_grant",
        "That authorization code has already been used. Everything issued from it has been revoked. Start the connection again."
      );
    }

    if (redemption.status === "not_found") {
      return oauthErrorResponse("invalid_grant", "That authorization code is not valid.");
    }

    if (redemption.status === "expired") {
      return oauthErrorResponse(
        "invalid_grant",
        "That authorization code has expired. Start the connection again."
      );
    }

    const code = redemption.code;

    if (code.clientRecordId !== client.id) {
      return oauthErrorResponse(
        "invalid_grant",
        "That authorization code was issued to a different client."
      );
    }

    // Exact string equality against the redirect_uri recorded at consent time.
    if (code.redirectUri !== body.redirect_uri) {
      return oauthErrorResponse(
        "invalid_grant",
        "redirect_uri does not match the one this code was issued for."
      );
    }

    if (
      !verifyCodeVerifier(
        body.code_verifier,
        code.codeChallenge,
        code.codeChallengeMethod
      )
    ) {
      return oauthErrorResponse(
        "invalid_grant",
        "code_verifier does not match the code_challenge sent with the authorization request."
      );
    }

    // RFC 8707. A resource on the token request must name the same server the
    // user approved, so a token cannot be redirected to a different audience
    // between consent and issue.
    if (body.resource) {
      const requested = canonicalizeResource(body.resource);
      if (!requested || requested !== canonicalizeResource(code.resource)) {
        return oauthErrorResponse(
          "invalid_target",
          "resource does not match the resource this authorization was granted for."
        );
      }
    }

    // Consent is not a standing grant. Membership is checked again here, so a
    // person removed from the workspace between approving and redeeming gets
    // no token at all.
    const role = await getMembershipRole(code.userId, code.workspaceId);
    if (!role) {
      return oauthErrorResponse(
        "invalid_grant",
        "You are no longer a member of the workspace this connection was approved for."
      );
    }

    const issued = await issueTokenPair({
      clientRecordId: client.id,
      authorizationCodeId: code.id,
      userId: code.userId,
      workspaceId: code.workspaceId,
      scope: code.scope,
      resource: code.resource,
    });

    return tokenResponse(issued);
  }

  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) {
      return oauthErrorResponse("invalid_request", "refresh_token is required.");
    }

    const result = await consumeRefreshToken(body.refresh_token, client.id);

    if (result.status === "reused") {
      return oauthErrorResponse(
        "invalid_grant",
        "That refresh token has already been used. The connection has been revoked. Start it again."
      );
    }

    if (result.status === "wrong_client") {
      return oauthErrorResponse(
        "invalid_grant",
        "That refresh token belongs to a different client."
      );
    }

    if (result.status === "expired") {
      return oauthErrorResponse(
        "invalid_grant",
        "That refresh token has expired. Start the connection again."
      );
    }

    if (result.status !== "ok") {
      return oauthErrorResponse("invalid_grant", "That refresh token is not valid.");
    }

    const grant = result.grant;

    const role = await getMembershipRole(grant.userId, grant.workspaceId);
    if (!role) {
      return oauthErrorResponse(
        "invalid_grant",
        "You are no longer a member of the workspace this connection was approved for."
      );
    }

    if (body.resource) {
      const requested = canonicalizeResource(body.resource);
      if (!requested || requested !== canonicalizeResource(grant.resource)) {
        return oauthErrorResponse(
          "invalid_target",
          "resource does not match the resource this connection was granted for."
        );
      }
    }

    // A refresh may narrow the scope but never widen it.
    let scope = grant.scope;
    if (body.scope) {
      const granted = parseScope(grant.scope);
      const requested = parseScope(body.scope);
      const outside = requested.filter((entry) => !granted.includes(entry));
      if (outside.length > 0) {
        return oauthErrorResponse(
          "invalid_scope",
          `This connection was not granted ${outside.join(", ")}.`
        );
      }
      scope = serializeScope(requested);
    }

    const issued = await issueTokenPair({
      clientRecordId: grant.clientRecordId,
      authorizationCodeId: grant.authorizationCodeId,
      userId: grant.userId,
      workspaceId: grant.workspaceId,
      scope,
      resource: grant.resource,
    });

    return tokenResponse(issued);
  }

  return oauthErrorResponse(
    "unsupported_grant_type",
    "This server supports authorization_code and refresh_token."
  );
}

export async function OPTIONS(): Promise<NextResponse> {
  return corsPreflight();
}
