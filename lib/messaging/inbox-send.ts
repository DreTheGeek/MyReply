import { releaseWorkspaceDMReservation, reserveWorkspaceDMSend } from "@/lib/billing/usage";
import { getChannelCapabilities } from "@/lib/channels/capabilities";
import { getChannelAdapter, openChannel } from "@/lib/channels/registry";
import type { SendReceipt } from "@/lib/channels/content";
import { isHumanAgentApproved, messagingWindow } from "@/lib/channels/windows";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";

/**
 * A reply a person typed into an inbox: the dashboard's, or a partner's
 * hosted inbox. One function, so both follow the same rules.
 *
 * A person is replying, so the platform's human rules apply: inside 24 hours
 * of their last message it is an ordinary reply; after that, only inside the
 * human agent window, and only once the app is approved for it. A
 * conversation with no recorded inbound (it predates the record) is sent as
 * is and the platform decides.
 *
 * It reserves the workspace budget first, then the per-account slot, the
 * order the worker uses, so a refused send hands the workspace reservation
 * back rather than silently consuming it.
 */

export type InboxSendResult =
  | { ok: true; receipt: SendReceipt }
  | { ok: false; status: number; error: string };

export async function sendInboxReply(input: {
  workspaceId: string;
  accountId: string | null;
  recipientId: string;
  text: string;
}): Promise<InboxSendResult> {
  const account = await getWorkspaceInstagramAccount(input.workspaceId, input.accountId);
  if (!account) return { ok: false, status: 400, error: "Instagram account not connected." };

  const contact = await prisma.contact.findUnique({
    where: {
      instagramAccountId_externalId: {
        instagramAccountId: account.id,
        externalId: input.recipientId,
      },
    },
    select: { lastInboundAt: true },
  });
  let humanAgent = false;
  if (contact?.lastInboundAt) {
    const decision = messagingWindow({
      capabilities: getChannelCapabilities(account.platform),
      lastInboundAt: contact.lastInboundAt,
      now: new Date(),
      sender: "human",
      humanAgentApproved: isHumanAgentApproved(),
    });
    if (!decision.allowed) {
      return {
        ok: false,
        status: 409,
        error:
          "This conversation can't be answered any more. They need to message you again before you can reply.",
      };
    }
    humanAgent = decision.humanAgentTag;
  }

  const usage = await reserveWorkspaceDMSend(input.workspaceId);
  if (!usage.allowed) {
    return { ok: false, status: 429, error: "This workspace has used its DM allowance for the period." };
  }

  const slot = await reserveDMSlot(account.instagramId).catch(() => null);
  if (!slot || !slot.allowed) {
    await releaseWorkspaceDMReservation(input.workspaceId, usage.periodStart);
    return {
      ok: false,
      status: 429,
      error: "This account has reached Instagram's hourly message limit. Try again shortly.",
    };
  }

  try {
    const channel = await openChannel(account, { source: "inbox" });
    const receipt = await channel.adapter.messaging.send(channel.context, {
      to: { kind: "user", userId: input.recipientId },
      content: { kind: "text", text: input.text },
      humanAgent,
    });
    return { ok: true, receipt };
  } catch (err) {
    await releaseWorkspaceDMReservation(input.workspaceId, usage.periodStart);
    console.error("[Inbox] Send error:", err);
    // Surface the platform's own message: the common case is the 24-hour
    // window having closed, which the person needs to see explicitly.
    const message = getChannelAdapter(account.platform).errors.userMessage(err) ?? "Failed to send message";
    return { ok: false, status: 502, error: message };
  }
}
