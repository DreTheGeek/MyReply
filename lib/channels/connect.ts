import { prisma } from "@/lib/db/client";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import { encryptToken } from "@/lib/security/token-crypto";
import { announceConnected } from "@/lib/webhooks/account-events";
import type { ChannelAdapter, ConnectedAccountGrant } from "./adapter";

export type ConnectRefusal = "already_connected" | "plan_limit" | "none_granted";

export interface StoreResult {
  connected: number;
  /** Why the first refused account was refused, when any was. */
  refused: ConnectRefusal | null;
}

/**
 * Store the accounts a platform granted, for one workspace.
 *
 * Each grant is checked the way an Instagram connect always was: an account
 * already held by another workspace is refused, and so is one past the plan's
 * account limit. The token is encrypted before it touches the database, and
 * the account is subscribed to the platform's events; a failed subscription is
 * logged and recorded as webhookSubscribed=false rather than failing the
 * connect, because the token refresh cron re-asserts it.
 */
export async function storeConnectedAccounts({
  adapter,
  grants,
  workspaceId,
}: {
  adapter: ChannelAdapter;
  grants: ConnectedAccountGrant[];
  workspaceId: string;
}): Promise<StoreResult> {
  if (grants.length === 0) return { connected: 0, refused: "none_granted" };

  let connected = 0;
  let refused: ConnectRefusal | null = null;

  for (const grant of grants) {
    const check = await canConnectInstagramAccount({
      workspaceId,
      instagramId: grant.externalId,
    });
    if (!check.allowed) {
      refused ??= check.reason;
      continue;
    }

    let webhookSubscribed = false;
    try {
      webhookSubscribed = await adapter.auth.subscribeToEvents({
        platform: adapter.platform,
        accountExternalId: grant.externalId,
        accessToken: grant.accessToken,
      });
    } catch (error) {
      console.warn(
        `[Connect] ${adapter.platform} event subscription failed:`,
        error instanceof Error ? error.message : "Unknown error"
      );
    }

    const data = {
      username: grant.username,
      name: grant.name,
      accessToken: encryptToken(grant.accessToken),
      tokenExpiresAt: grant.expiresAt,
      webhookSubscribed,
      // Only overwritten when the platform said, so a reconnect that could
      // not read it keeps the id recorded last time.
      ...(grant.authorizedByExternalId
        ? { authorizedByExternalId: grant.authorizedByExternalId }
        : {}),
    };

    const existing = await prisma.instagramAccount.findUnique({
      where: { instagramId: grant.externalId },
      select: { id: true },
    });
    let accountId: string;
    if (existing) {
      const updated = await prisma.instagramAccount.updateMany({
        where: { id: existing.id, workspaceId, platform: adapter.platform },
        data,
      });
      if (updated.count === 0) {
        refused ??= "already_connected";
        continue;
      }
      accountId = existing.id;
    } else {
      const created = await prisma.instagramAccount.create({
        data: {
          ...data,
          workspaceId,
          instagramId: grant.externalId,
          platform: adapter.platform,
        },
        select: { id: true },
      });
      accountId = created.id;
    }
    connected += 1;
    await announceConnected({
      id: accountId,
      workspaceId,
      platform: adapter.platform,
      username: grant.username,
      name: grant.name,
      reconnected: existing !== null,
    });
  }

  return { connected, refused };
}
