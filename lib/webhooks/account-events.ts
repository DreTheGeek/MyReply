import type { ChannelPlatform } from "@/app/generated/prisma/client";
import { emitEvent } from "./events";

/**
 * account.connected and account.disconnected, in one shape whichever path
 * raised them, so a partner reads the same fields from a reconnect in its own
 * hosted page, a disconnect in the dashboard, or a removal on the platform.
 */

export type DisconnectReason =
  /** Someone disconnected it here, in the dashboard or through the API. */
  | "disconnected"
  /** The person removed the app on the platform. The account stays, paused. */
  | "removed_on_platform"
  /** The person asked the platform for their data to be deleted, and it was. */
  | "data_deleted";

export async function announceConnected(account: {
  id: string;
  workspaceId: string;
  platform: ChannelPlatform;
  username: string;
  name: string | null;
  reconnected: boolean;
}): Promise<void> {
  await emitEvent({
    workspaceId: account.workspaceId,
    type: "account.connected",
    data: {
      account: {
        id: account.id,
        platform: account.platform,
        username: account.username,
        name: account.name,
      },
      reconnected: account.reconnected,
    },
  });
}

export async function announceDisconnected(
  accounts: { id: string; workspaceId: string }[],
  platform: ChannelPlatform,
  reason: DisconnectReason
): Promise<void> {
  for (const account of accounts) {
    await emitEvent({
      workspaceId: account.workspaceId,
      type: "account.disconnected",
      data: { account: { id: account.id, platform }, reason },
    });
  }
}
