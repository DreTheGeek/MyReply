import { prisma } from "@/lib/db/client";
import { AUTHORIZATION_CODE_TTL_MS } from "@/lib/oauth/config";
import {
  AUTHORIZATION_CODE_PREFIX,
  generateSecret,
  hashSecret,
} from "@/lib/oauth/secrets";
import { revokeGrantTokens } from "@/lib/oauth/tokens";

/**
 * Authorization codes: sixty seconds, one use, and bound to everything that was
 * true when the user approved them.
 */

export interface AuthorizationCodeInput {
  clientRecordId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
}

export async function issueAuthorizationCode(
  input: AuthorizationCodeInput
): Promise<string> {
  const { plaintext, hashed } = generateSecret(AUTHORIZATION_CODE_PREFIX);

  await prisma.oAuthAuthorizationCode.create({
    data: {
      hashedCode: hashed,
      clientRecordId: input.clientRecordId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      redirectUri: input.redirectUri,
      scope: input.scope,
      resource: input.resource,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
    },
  });

  return plaintext;
}

export interface RedeemedCode {
  id: string;
  clientRecordId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export type CodeRedemption =
  | { status: "ok"; code: RedeemedCode }
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "replayed"; revokedTokens: number };

/**
 * Claim a code, at most once.
 *
 * The claim is a conditional update on `consumedAt` being null, so two requests
 * racing on the same code cannot both win. The loser is told the code was
 * replayed, and every token the first redemption issued is revoked: a code
 * arriving twice means somebody other than the client has a copy of it, and the
 * tokens it already produced have to be assumed compromised.
 */
export async function redeemAuthorizationCode(
  plaintext: string
): Promise<CodeRedemption> {
  const hashedCode = hashSecret(plaintext);

  const claimed = await prisma.oAuthAuthorizationCode.updateMany({
    where: { hashedCode, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const record = await prisma.oAuthAuthorizationCode.findUnique({
    where: { hashedCode },
    select: {
      id: true,
      clientRecordId: true,
      userId: true,
      workspaceId: true,
      redirectUri: true,
      scope: true,
      resource: true,
      codeChallenge: true,
      codeChallengeMethod: true,
      expiresAt: true,
    },
  });

  if (!record) return { status: "not_found" };

  if (claimed.count === 0) {
    const revokedTokens = await revokeGrantTokens(record.id);
    return { status: "replayed", revokedTokens };
  }

  if (record.expiresAt <= new Date()) return { status: "expired" };

  return {
    status: "ok",
    code: {
      id: record.id,
      clientRecordId: record.clientRecordId,
      userId: record.userId,
      workspaceId: record.workspaceId,
      redirectUri: record.redirectUri,
      scope: record.scope,
      resource: record.resource,
      codeChallenge: record.codeChallenge,
      codeChallengeMethod: record.codeChallengeMethod,
    },
  };
}
