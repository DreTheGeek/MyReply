import { createHash, randomBytes } from "crypto";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db/client";
import type { ChannelPlatform } from "./platforms";

/**
 * What the engine does when a platform says a person removed the app, or
 * asked for their data to be deleted.
 *
 * The person is named by the platform's app-scoped id. An account is theirs
 * when they granted it (authorizedByExternalId), or, for Instagram, when the
 * account itself is theirs: an Instagram professional account logs in as
 * itself, and rows connected before the granting id was recorded have only
 * that to match on.
 */

async function accountsAuthorizedBy(
  platform: ChannelPlatform,
  userId: string
): Promise<Array<{ id: string; workspaceId: string }>> {
  return prisma.instagramAccount.findMany({
    where: {
      platform,
      OR: [
        { authorizedByExternalId: userId },
        ...(platform === "INSTAGRAM" ? [{ instagramId: userId }] : []),
      ],
    },
    select: { id: true, workspaceId: true },
  });
}

/** One audit row per workspace touched, never naming the person. */
async function auditPerWorkspace(
  accounts: Array<{ id: string; workspaceId: string }>,
  action: "channel.deauthorized" | "channel.data_deleted",
  platform: ChannelPlatform
): Promise<void> {
  const byWorkspace = new Map<string, string[]>();
  for (const account of accounts) {
    byWorkspace.set(account.workspaceId, [...(byWorkspace.get(account.workspaceId) ?? []), account.id]);
  }
  for (const [workspaceId, accountIds] of byWorkspace) {
    await recordAuditEvent({
      workspaceId,
      action,
      actorUserId: null,
      detail: { platform, accounts: accountIds.length, accountIds: accountIds.join(",") },
    });
  }
}

/**
 * The person removed the app: the platform has already revoked the token.
 *
 * The stored token is erased and every campaign on those accounts is paused,
 * so nothing tries to send on a dead credential. The accounts and their
 * history stay, because removing the app is not a deletion request (that one
 * comes separately), and reconnecting puts a fresh token on the same row.
 */
export async function deauthorizeChannelUser(
  platform: ChannelPlatform,
  userId: string
): Promise<{ accounts: number }> {
  const accounts = await accountsAuthorizedBy(platform, userId);
  if (accounts.length === 0) return { accounts: 0 };

  const ids = accounts.map((account) => account.id);
  await prisma.$transaction([
    prisma.instagramAccount.updateMany({
      where: { id: { in: ids } },
      data: { accessToken: "", tokenExpiresAt: new Date(), webhookSubscribed: false },
    }),
    prisma.automation.updateMany({
      where: { instagramAccountId: { in: ids } },
      data: { isActive: false },
    }),
  ]);
  await auditPerWorkspace(accounts, "channel.deauthorized", platform);
  return { accounts: accounts.length };
}

/** A code a person can read out or paste: 16 characters, no look-alikes. */
function newConfirmationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

export function hashPlatformUserId(platform: ChannelPlatform, userId: string): string {
  return createHash("sha256").update(`${platform}:${userId}`).digest("hex");
}

/**
 * The person asked for their data to be deleted.
 *
 * Every account they connected is deleted, and the database cascades take its
 * campaigns, conversations, contacts, consents and delivery history with it.
 * The request is recorded first, with the person's id only as a hash, so the
 * confirmation code resolves even if the delete fails part way; it is marked
 * complete once the delete has committed.
 */
export async function deleteChannelUserData(
  platform: ChannelPlatform,
  userId: string
): Promise<{ confirmationCode: string; accounts: number }> {
  const confirmationCode = newConfirmationCode();
  const request = await prisma.dataDeletionRequest.create({
    data: { confirmationCode, platform, userIdHash: hashPlatformUserId(platform, userId) },
    select: { id: true },
  });

  const accounts = await accountsAuthorizedBy(platform, userId);
  if (accounts.length > 0) {
    await prisma.instagramAccount.deleteMany({
      where: { id: { in: accounts.map((account) => account.id) } },
    });
  }
  await prisma.dataDeletionRequest.update({
    where: { id: request.id },
    data: { accountsDeleted: accounts.length, completedAt: new Date() },
  });
  await auditPerWorkspace(accounts, "channel.data_deleted", platform);
  return { confirmationCode, accounts: accounts.length };
}

/** A confirmation code, as the status page shows it. */
export async function findDataDeletionRequest(code: string): Promise<{
  platform: ChannelPlatform;
  requestedAt: Date;
  completedAt: Date | null;
} | null> {
  return prisma.dataDeletionRequest.findUnique({
    where: { confirmationCode: code },
    select: { platform: true, requestedAt: true, completedAt: true },
  });
}
