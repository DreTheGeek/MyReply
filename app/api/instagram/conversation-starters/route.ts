import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMetaGraphApiVersion } from "@/lib/env";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  clearConversationStarters,
  setConversationStarters,
  MetaApiError,
  type ConversationStarter,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

// Meta's own ceiling. Instagram shows at most four prompts on a fresh thread,
// and setConversationStarters silently truncates past it, so reject the
// overflow here instead of pretending we saved something we did not.
const MAX_STARTERS = 4;

// Instagram caps a starter question at 80 characters. The payload is ours, and
// only comes back to us as a postback, so it gets the same 1000-char ceiling
// the campaign message fields use.
const MAX_QUESTION_LENGTH = 80;
const MAX_PAYLOAD_LENGTH = 1000;

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
  starters: ConversationStarter[];
  /**
   * False when we could not read the live set back from Meta. The UI shows the
   * section as write-only in that case rather than presenting an empty list as
   * though it were the account's real state.
   */
  readable: boolean;
  maxStarters: number;
}

type RawStarter = {
  question?: unknown;
  payload?: unknown;
  call_to_actions?: unknown;
};

/**
 * Normalise whatever Meta hands back into our own shape. Messenger nests the
 * prompts under a per-locale `call_to_actions` array while Instagram returns
 * them flat, and the same account id can answer in either shape depending on
 * how it was connected, so accept both.
 */
function toStarters(raw: unknown): ConversationStarter[] {
  if (!Array.isArray(raw)) return [];

  const starters: ConversationStarter[] = [];
  for (const entry of raw as RawStarter[]) {
    if (Array.isArray(entry?.call_to_actions)) {
      starters.push(...toStarters(entry.call_to_actions));
      continue;
    }
    if (
      typeof entry?.question === "string" &&
      typeof entry?.payload === "string"
    ) {
      starters.push({ question: entry.question, payload: entry.payload });
    }
  }
  return starters;
}

/**
 * Read the account's current starters back from Meta.
 *
 * Honest note on the approach: Meta documents a GET on `messenger_profile` with
 * `fields=ice_breakers`, and that is what this does, but it has not been
 * verified against a live Instagram Login account here. Reports of it answering
 * with an empty payload on accounts that demonstrably have starters set are
 * common enough that we do not treat a failed read as "none configured".
 * Starters are not mirrored in our database (they live only on the Instagram
 * profile), so there is no last-saved copy to fall back on: a read that throws,
 * 4xxs, or comes back in a shape we do not recognise returns null, the route
 * reports `readable: false`, and the UI degrades to a write-only editor.
 *
 * This lives here rather than in lib/meta/client.ts because it is the only
 * caller and its result is advisory, not something the send path depends on.
 */
async function readConversationStarters(
  accessToken: string,
  instagramAccountId: string
): Promise<ConversationStarter[] | null> {
  const url = new URL(
    `https://graph.instagram.com/${getMetaGraphApiVersion()}/${instagramAccountId}/messenger_profile`
  );
  url.searchParams.set("platform", "instagram");
  url.searchParams.set("fields", "ice_breakers");
  url.searchParams.set("access_token", accessToken);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return null;

    const body: unknown = await response.json();
    const entries = (body as { data?: unknown })?.data;
    // An array is the success signal, including an empty one: Meta returns
    // `{"data":[]}` for a profile with the field genuinely unset.
    if (!Array.isArray(entries)) return null;

    const field = (entries as Array<{ ice_breakers?: unknown }>).find((entry) =>
      Array.isArray(entry?.ice_breakers)
    );
    return field ? toStarters(field.ice_breakers) : [];
  } catch (err) {
    console.warn(
      "[ConversationStarters] Read unavailable:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
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

  const starters = await readConversationStarters(
    decryptToken(account.accessToken),
    account.instagramId
  );

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

  try {
    await setConversationStarters(
      decryptToken(account.accessToken),
      account.instagramId,
      parsed.data.starters
    );
  } catch (err) {
    console.error("[ConversationStarters] Save error:", err);
    // Meta's own message is worth surfacing here. The usual failures are a
    // missing messaging permission or an expired token, both of which the user
    // has to act on themselves.
    const message =
      err instanceof MetaApiError
        ? err.message
        : "Failed to save conversation starters";
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

  try {
    await clearConversationStarters(
      decryptToken(account.accessToken),
      account.instagramId
    );
  } catch (err) {
    console.error("[ConversationStarters] Clear error:", err);
    const message =
      err instanceof MetaApiError
        ? err.message
        : "Failed to clear conversation starters";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
