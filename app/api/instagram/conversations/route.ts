import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getChannelCapabilities } from "@/lib/channels/capabilities";
import { getChannelAdapter, openChannel } from "@/lib/channels/registry";
import { isHumanAgentApproved, messagingWindow } from "@/lib/channels/windows";
import { prisma } from "@/lib/db/client";

export interface ConversationListItem {
  id: string;
  detailsUnavailable?: boolean;
  contact: { id: string; username: string | null };
  updatedTime: string | null;
  lastMessage: {
    text: string;
    fromMe: boolean;
    createdTime: string | null;
  } | null;
}

export interface ConversationsResponse {
  conversations: ConversationListItem[];
  account: { id: string; username: string; instagramId: string };
}

// List the account's DM conversations for the inbox.
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  const adapter = getChannelAdapter(account.platform);
  if (!adapter.inbox) {
    return NextResponse.json(
      { success: false, error: "This account's platform has no inbox to read." },
      { status: 400 }
    );
  }

  try {
    const channel = await openChannel(account);
    const raw = await adapter.inbox.conversations(channel.context);

    const conversations: ConversationListItem[] = raw.map((c) => {
      const contact =
        c.participants.find((p) => p.id !== account.instagramId) ?? null;
      const last = c.messages[0] ?? null;

      return {
        id: c.id,
        detailsUnavailable: c.detailsUnavailable,
        contact: {
          id: contact?.id ?? "",
          username: contact?.username ?? null,
        },
        updatedTime: c.updatedAt,
        lastMessage: last
          ? {
              text: last.text ?? "",
              fromMe: last.fromId === account.instagramId,
              createdTime: last.createdAt,
            }
          : null,
      };
    });

    const data: ConversationsResponse = {
      conversations,
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
    };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[Conversations] Error:", err);
    const message =
      adapter.errors.userMessage(err) ?? "Failed to load conversations";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

/**
 * The manual reply from the inbox.
 *
 * Three things were missing and all three mattered.
 *
 * It authenticated with getCurrentWorkspaceId(), which resolves an API key
 * before falling back to the session, and applied no role check. A MEMBER key,
 * which lib/mcp/tools.ts describes to the model as read only, could therefore
 * send a DM from the brand's live Instagram account to any IGSID.
 *
 * It was the only mutating handler in app/api with no schema, reading fields
 * off a hand-written interface and passing them to Meta after a truthiness
 * check.
 *
 * And it called sendDirectMessage without reserving anything, so it neither
 * consumed the atomic Redis reservation against Meta's 750 an hour cap nor the
 * workspace's own send budget. The worker went on believing the account had
 * its full budget, so the account tripped Meta's real limit and the requeue
 * logic mis-reported why.
 */
const sendSchema = z.object({
  instagramAccountId: z.string().min(1).optional().nullable(),
  recipientId: z.string().min(1),
  text: z.string().trim().min(1).max(1000),
});

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can send messages" },
      { status: 403 }
    );
  }

  const parsed = sendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "A recipient and message are required." },
      { status: 400 }
    );
  }

  const { recipientId, text } = parsed.data;

  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    parsed.data.instagramAccountId ?? null
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  // A person is replying, so the platform's human rules apply: inside 24 hours
  // of their last message it is an ordinary reply; after that, only inside the
  // human agent window, and only once the app is approved for it. A
  // conversation with no recorded inbound (it predates the record) is sent as
  // is and the platform decides.
  const contact = await prisma.contact.findUnique({
    where: {
      instagramAccountId_externalId: {
        instagramAccountId: account.id,
        externalId: recipientId,
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
      return NextResponse.json(
        {
          success: false,
          error:
            "This conversation can't be answered any more. They need to message you again before you can reply.",
        },
        { status: 409 }
      );
    }
    humanAgent = decision.humanAgentTag;
  }

  // Same order the worker uses: the workspace budget first, then the per
  // account slot, so a rejected send releases the workspace reservation rather
  // than silently consuming it.
  const usage = await reserveWorkspaceDMSend(context.workspaceId);
  if (!usage.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "This workspace has used its DM allowance for the period.",
      },
      { status: 429 }
    );
  }

  const slot = await reserveDMSlot(account.instagramId).catch(() => null);
  if (!slot || !slot.allowed) {
    await releaseWorkspaceDMReservation(context.workspaceId, usage.periodStart);
    return NextResponse.json(
      {
        success: false,
        error:
          "This account has reached Instagram's hourly message limit. Try again shortly.",
      },
      { status: 429 }
    );
  }

  try {
    const channel = await openChannel(account, { source: "inbox" });
    const result = await channel.adapter.messaging.send(channel.context, {
      to: { kind: "user", userId: recipientId },
      content: { kind: "text", text },
      humanAgent,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    await releaseWorkspaceDMReservation(context.workspaceId, usage.periodStart);
    console.error("[Conversations] Send error:", err);
    // Surface Meta's own message, the common case is the 24-hour messaging
    // window having closed, which the user needs to see explicitly.
    const message =
      getChannelAdapter(account.platform).errors.userMessage(err) ??
      "Failed to send message";
    return NextResponse.json(
      { success: false, error: message },
      { status: 502 }
    );
  }
}
