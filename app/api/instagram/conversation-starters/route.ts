import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getChannelCapabilities } from "@/lib/channels/capabilities";
import type { IceBreaker } from "@/lib/channels/content";
import {
  openProfileSettings,
  profileSettingsUnsupported,
} from "@/lib/channels/profile-settings";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

// Instagram's ceilings, from its channel capabilities. Instagram shows at most
// four prompts on a fresh thread and truncates past it, so the overflow is
// refused here instead of pretending we saved something we did not. A
// question is capped at 80 characters; the payload is ours, and only comes
// back to us as a postback, so it gets the 1000-char ceiling campaign message
// fields use.
const LIMITS = getChannelCapabilities("INSTAGRAM").iceBreakers;
const MAX_STARTERS = LIMITS.max;
const MAX_QUESTION_LENGTH = LIMITS.questionMax;
const MAX_PAYLOAD_LENGTH = LIMITS.payloadMax;

// "all" is the account-selector sentinel meaning "no account in particular". It
// resolves to whichever account connected most recently, which is not something
// a write to a live Instagram profile should ever guess at.
const accountIdSchema = z
  .string()
  .min(1)
  .refine((value) => value !== "all", "Choose a specific account");

const starterSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  payload: z.string().trim().min(1).max(MAX_PAYLOAD_LENGTH),
});

const putSchema = z.object({
  instagramAccountId: accountIdSchema,
  // Meta rejects an empty ice_breakers array, so clearing goes through DELETE
  // rather than through a PUT with nothing in it.
  starters: z.array(starterSchema).min(1).max(MAX_STARTERS),
});

const deleteSchema = z.object({
  instagramAccountId: accountIdSchema,
});

export interface ConversationStartersResponse {
  account: { id: string; username: string };
  starters: IceBreaker[];
  /**
   * False when we could not read the live set back from Meta. The UI shows the
   * section as write-only in that case rather than presenting an empty list as
   * though it were the account's real state.
   */
  readable: boolean;
  maxStarters: number;
}

/** The starters currently configured on one of the workspace's accounts. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Resolved through the workspace, so an id belonging to another tenant simply
  // does not match and falls through to the not-connected branch.
  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  const opened = await openProfileSettings(account);
  if (!opened) return profileSettingsUnsupported();
  const starters = await opened.settings.iceBreakers(opened.context);

  const data: ConversationStartersResponse = {
    account: { id: account.id, username: account.username },
    starters: starters ?? [],
    readable: starters !== null,
    maxStarters: MAX_STARTERS,
  };
  return NextResponse.json({ success: true, data });
}

/** Replace the whole set. Meta has no partial update for ice breakers. */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only owners and admins can change conversation starters",
      },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: `Send between 1 and ${MAX_STARTERS} starters, each with a question of up to ${MAX_QUESTION_LENGTH} characters and a payload.`,
      },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    parsed.data.instagramAccountId
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not found." },
      { status: 404 }
    );
  }

  const opened = await openProfileSettings(account);
  if (!opened) return profileSettingsUnsupported();

  try {
    await opened.settings.setIceBreakers(opened.context, parsed.data.starters);
  } catch (err) {
    console.error("[ConversationStarters] Save error:", err);
    // Meta's own message is worth surfacing here. The usual failures are a
    // missing messaging permission or an expired token, both of which the user
    // has to act on themselves.
    const message =
      opened.errors.userMessage(err) ?? "Failed to save conversation starters";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }

  const data: ConversationStartersResponse = {
    account: { id: account.id, username: account.username },
    starters: parsed.data.starters,
    // Echoing back what we just wrote, not a fresh read from Meta.
    readable: true,
    maxStarters: MAX_STARTERS,
  };
  return NextResponse.json({ success: true, data });
}

/** Remove every starter. Instagram then shows a fresh thread with no prompts. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only owners and admins can change conversation starters",
      },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "instagramAccountId is required" },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    parsed.data.instagramAccountId
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not found." },
      { status: 404 }
    );
  }

  const opened = await openProfileSettings(account);
  if (!opened) return profileSettingsUnsupported();

  try {
    await opened.settings.clearIceBreakers(opened.context);
  } catch (err) {
    console.error("[ConversationStarters] Clear error:", err);
    const message =
      opened.errors.userMessage(err) ?? "Failed to clear conversation starters";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
