import { prisma } from "@/lib/db/client";
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  canonicalizeResource,
} from "@/lib/oauth/config";
import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  generateSecret,
  hashSecret,
} from "@/lib/oauth/secrets";

/**
 * Issuing, resolving and rotating tokens.
 *
 * Both kinds are stored as SHA-256 hashes and nothing else, so a dumped table
 * is a list of useless digests. Every row carries the `resource` it was minted
 * for, which is what makes audience binding checkable at the point of use
 * rather than a promise made at issue time.
 */

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds, for the token response. */
  expiresIn: number;
  scope: string;
}

export interface GrantDetails {
  clientRecordId: string;
  authorizationCodeId: string | null;
  userId: string;
  workspaceId: string;
  scope: string;
  resource: string;
}

export async function issueTokenPair(grant: GrantDetails): Promise<IssuedTokenPair> {
  const access = generateSecret(ACCESS_TOKEN_PREFIX);
  const refresh = generateSecret(REFRESH_TOKEN_PREFIX);
  const now = Date.now();

  await prisma.oAuthToken.createMany({
    data: [
      {
        type: "ACCESS",
        hashedToken: access.hashed,
        clientRecordId: grant.clientRecordId,
        authorizationCodeId: grant.authorizationCodeId,
        userId: grant.userId,
        workspaceId: grant.workspaceId,
        scope: grant.scope,
        resource: grant.resource,
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
      },
      {
        type: "REFRESH",
        hashedToken: refresh.hashed,
        clientRecordId: grant.clientRecordId,
        authorizationCodeId: grant.authorizationCodeId,
        userId: grant.userId,
        workspaceId: grant.workspaceId,
        scope: grant.scope,
        resource: grant.resource,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      },
    ],
  });

  return {
    accessToken: access.plaintext,
    refreshToken: refresh.plaintext,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: grant.scope,
  };
}

export interface ResolvedAccessToken {
  id: string;
  userId: string;
  workspaceId: string;
  scope: string;
  resource: string;
  clientRecordId: string;
}

export type AccessTokenResolution =
  | { status: "ok"; token: ResolvedAccessToken }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "wrong_audience" };

/**
 * Resolve a presented access token, refusing one that was not minted for us.
 *
 * The audience check is here, on the stored `resource`, and it is the reason a
 * token a user approved for some other MCP server cannot be replayed against
 * this one: the row says which server it was for, and this comparison is the
 * only way past.
 */
export async function resolveAccessToken(
  plaintext: string,
  expectedResource: string
): Promise<AccessTokenResolution> {
  const record = await prisma.oAuthToken.findUnique({
    where: { hashedToken: hashSecret(plaintext) },
    select: {
      id: true,
      type: true,
      userId: true,
      workspaceId: true,
      scope: true,
      resource: true,
      clientRecordId: true,
      expiresAt: true,
      revokedAt: true,
      client: { select: { disabledAt: true } },
    },
  });

  if (!record) return { status: "invalid" };
  if (record.type !== "ACCESS") return { status: "invalid" };
  if (record.revokedAt) return { status: "invalid" };
  if (record.client.disabledAt) return { status: "invalid" };
  if (record.expiresAt <= new Date()) return { status: "expired" };

  const bound = canonicalizeResource(record.resource);
  const wanted = canonicalizeResource(expectedResource);
  if (!bound || !wanted || bound !== wanted) {
    return { status: "wrong_audience" };
  }

  return {
    status: "ok",
    token: {
      id: record.id,
      userId: record.userId,
      workspaceId: record.workspaceId,
      scope: record.scope,
      resource: record.resource,
      clientRecordId: record.clientRecordId,
    },
  };
}

/**
 * Best-effort usage stamp, deliberately not awaited and deliberately swallowing
 * errors. Bookkeeping must never turn a valid request into a failed one.
 */
export function touchAccessToken(tokenId: string): void {
  void prisma.oAuthToken
    .update({ where: { id: tokenId }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
}

/**
 * Revoke every token that came out of one authorization code.
 *
 * Called when a code is replayed and when a refresh token is reused. Both mean
 * somebody other than the client is holding a copy, and the safe answer is to
 * end the whole grant rather than only the token that was presented.
 */
export async function revokeGrantTokens(
  authorizationCodeId: string
): Promise<number> {
  const result = await prisma.oAuthToken.updateMany({
    where: { authorizationCodeId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export interface RefreshedGrant {
  clientRecordId: string;
  authorizationCodeId: string | null;
  userId: string;
  workspaceId: string;
  scope: string;
  resource: string;
}

export type RefreshTokenResolution =
  | { status: "ok"; grant: RefreshedGrant }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "reused" }
  | { status: "wrong_client" };

/**
 * Spend a refresh token.
 *
 * Rotation with reuse detection: the presented token is marked used and
 * revoked in the same update, and that update is conditional on it not already
 * being used. A second presentation therefore matches nothing, which is the
 * signal that a copy leaked, and the entire grant is revoked.
 */
export async function consumeRefreshToken(
  plaintext: string,
  clientRecordId: string
): Promise<RefreshTokenResolution> {
  const hashedToken = hashSecret(plaintext);
  const record = await prisma.oAuthToken.findUnique({
    where: { hashedToken },
    select: {
      id: true,
      type: true,
      clientRecordId: true,
      authorizationCodeId: true,
      userId: true,
      workspaceId: true,
      scope: true,
      resource: true,
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
    },
  });

  if (!record || record.type !== "REFRESH") return { status: "invalid" };
  if (record.clientRecordId !== clientRecordId) return { status: "wrong_client" };

  if (record.usedAt || record.revokedAt) {
    if (record.authorizationCodeId) {
      await revokeGrantTokens(record.authorizationCodeId);
    }
    return { status: "reused" };
  }

  if (record.expiresAt <= new Date()) return { status: "expired" };

  const now = new Date();
  const spent = await prisma.oAuthToken.updateMany({
    where: { id: record.id, usedAt: null, revokedAt: null },
    data: { usedAt: now, revokedAt: now },
  });

  // Lost the race with a concurrent redemption of the same token. Treat it as
  // reuse rather than issuing a second pair from one refresh token.
  if (spent.count === 0) {
    if (record.authorizationCodeId) {
      await revokeGrantTokens(record.authorizationCodeId);
    }
    return { status: "reused" };
  }

  return {
    status: "ok",
    grant: {
      clientRecordId: record.clientRecordId,
      authorizationCodeId: record.authorizationCodeId,
      userId: record.userId,
      workspaceId: record.workspaceId,
      scope: record.scope,
      resource: record.resource,
    },
  };
}

/**
 * RFC 7009 revocation. Revoking a refresh token ends the whole grant, which is
 * what a person means when they disconnect an app.
 */
export async function revokeTokenByPlaintext(plaintext: string): Promise<void> {
  const record = await prisma.oAuthToken.findUnique({
    where: { hashedToken: hashSecret(plaintext) },
    select: { id: true, type: true, authorizationCodeId: true },
  });

  if (!record) return;

  if (record.type === "REFRESH" && record.authorizationCodeId) {
    await revokeGrantTokens(record.authorizationCodeId);
    return;
  }

  await prisma.oAuthToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
