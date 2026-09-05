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
import {
  getConversations,
  sendDirectMessage,
  MetaApiError,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

export interface ConversationListItem {
  id: string;
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

  try {
    const accessToken = decryptToken(account.accessToken);
    const raw = await getConversations(accessToken, account.instagramId);

    const conversations: ConversationListItem[] = raw.map((c) => {
      const participants = c.participants?.data ?? [];
      const contact =
        participants.find((p) => p.id !== account.instagramId) ??
        participants[0] ??
        null;
      const last = c.messages?.data?.[0] ?? null;

      return {
        id: c.id,
        contact: {
          id: contact?.id ?? "",
          username: contact?.username ?? null,
        },
        updatedTime: c.updated_time ?? null,
        lastMessage: last
          ? {
              text: last.message ?? "",
              fromMe: last.from?.id === account.instagramId,
              createdTime: last.created_time ?? null,
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
      err instanceof MetaApiError
        ? err.message
        : "Failed to load conversations";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
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
    const accessToken = decryptToken(account.accessToken);
    const result = await sendDirectMessage(
      accessToken,
      account.instagramId,
      recipientId,
      text
    );
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    await releaseWorkspaceDMReservation(context.workspaceId, usage.periodStart);
    console.error("[Conversations] Send error:", err);
    // Surface Meta's own message — the common case is the 24-hour messaging
    // window having closed, which the user needs to see explicitly.
    const message =
      err instanceof MetaApiError ? err.message : "Failed to send message";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
