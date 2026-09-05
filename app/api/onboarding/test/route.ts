import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  MetaApiError,
  sendDirectMessage,
  sendDirectMessageWithLinkButton,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  buildTrackedUrl,
  renderMessageWithTracking,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const testSchema = z.object({
  automationId: z.string().min(1).max(200),
});

/**
 * Instagram will only let a business message someone who messaged it first,
 * and only for 24 hours after they did. There is no way around this and no
 * point retrying: a send outside the window is refused by Meta every time.
 */
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Meta's wording when the 24 hour window has closed. */
const WINDOW_CLOSED = /outside of allowed window/i;

/**
 * What to tell someone whose window is shut. Plain language, and it names the
 * one action that opens it, because "failed to send" would leave them with
 * nothing to do.
 */
function windowClosedMessage(username: string): string {
  return (
    `Instagram only lets us message someone who has messaged @${username} in the last 24 hours, ` +
    `and nobody has. Open Instagram on your phone, send @${username} any message from your personal ` +
    `account, then tap Send test again.`
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can send a test" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid input" },
      { status: 400 }
    );
  }

  const parsed = testSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input" },
      { status: 400 }
    );
  }

  // Scoped by workspace, so a campaign id from another tenant simply is not
  // found rather than being sent on their behalf.
  const automation = await prisma.automation.findFirst({
    where: { id: parsed.data.automationId, workspaceId: context.workspaceId },
    include: {
      instagramAccount: {
        select: {
          id: true,
          instagramId: true,
          username: true,
          accessToken: true,
        },
      },
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!automation) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  const account = automation.instagramAccount;

  /**
   * The recipient. Instagram gives no way to look up "the account owner's
   * personal profile", so the only person we can legitimately message is
   * someone who has an open messaging window with this account. The most
   * recent of those is the owner who has just followed the on-screen
   * instruction to DM themselves.
   */
  const contact = await prisma.contact.findFirst({
    where: {
      workspaceId: context.workspaceId,
      instagramAccountId: account.id,
      lastSeenAt: { gte: new Date(Date.now() - MESSAGING_WINDOW_MS) },
    },
    orderBy: { lastSeenAt: "desc" },
    select: { externalId: true, username: true },
  });

  if (!contact) {
    return NextResponse.json({
      success: true,
      data: {
        status: "window_closed" as const,
        message: windowClosedMessage(account.username),
      },
    });
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(account.accessToken);
  } catch (error) {
    console.error("[Onboarding] Could not decrypt Instagram token:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          "We could not reach your Instagram account. Reconnect it in Settings and try again.",
      },
      { status: 502 }
    );
  }

  // Rendered exactly the way lib/queue/dm-worker.ts renders it, so the test is
  // the real message and not an approximation of it: with tracked links the
  // body drops the {link} token and the URLs ride on buttons; without them the
  // token is substituted inline.
  const hasLinks = automation.trackedLinks.length > 0;
  const bodyText = hasLinks
    ? renderMessageWithoutLink({
        message: automation.dmMessage,
        commenterName: contact.username,
      }) || "Here's your link:"
    : renderMessageWithTracking({
        message: automation.dmMessage,
        commenterName: contact.username,
      });

  try {
    if (hasLinks) {
      const buttons = automation.trackedLinks.slice(0, 3).map((link, index) => ({
        url: buildTrackedUrl(link.slug),
        title:
          (index === 0 ? automation.linkButtonLabel : link.label) ||
          link.label ||
          "Open link",
      }));
      await sendDirectMessageWithLinkButton(
        accessToken,
        account.instagramId,
        contact.externalId,
        bodyText,
        buttons
      );
    } else {
      await sendDirectMessage(
        accessToken,
        account.instagramId,
        contact.externalId,
        bodyText
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";

    // Meta is the authority on the window, not our contact timestamps: a
    // contact seen 23 hours ago can still be outside it. Say the same plain
    // sentence rather than surfacing Meta's wording.
    if (WINDOW_CLOSED.test(detail)) {
      return NextResponse.json({
        success: true,
        data: {
          status: "window_closed" as const,
          message: windowClosedMessage(account.username),
        },
      });
    }

    console.error("[Onboarding] Test send failed:", {
      automationId: automation.id,
      code: error instanceof MetaApiError ? error.code : undefined,
    });

    return NextResponse.json(
      {
        success: false,
        error: "Instagram would not deliver the test message. Try again shortly.",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: true,
    data: {
      status: "sent" as const,
      sentTo: contact.username ?? null,
      message: contact.username
        ? `Sent to @${contact.username}. Check your Instagram DMs.`
        : "Sent. Check your Instagram DMs.",
    },
  });
}
