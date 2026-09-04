import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { MetaApiError } from "@/lib/meta/client";
import {
  clearPersistentMenu,
  getPersistentMenu,
  setPersistentMenu,
  MAX_MENU_ITEM_PAYLOAD,
  MAX_MENU_ITEM_TITLE,
  MAX_PERSISTENT_MENU_ITEMS,
  type PersistentMenuItem,
} from "@/lib/meta/persistent-menu";
import { decryptToken } from "@/lib/meta/oauth";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

// "all" is the account-selector sentinel meaning "no account in particular". It
// resolves to whichever account connected most recently, which is not something
// a write to a live Instagram profile should ever guess at.
const accountIdSchema = z
  .string()
  .min(1)
  .refine((value) => value !== "all", "Choose a specific account");

const titleSchema = z.string().trim().min(1).max(MAX_MENU_ITEM_TITLE);

const itemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("postback"),
    title: titleSchema,
    payload: z.string().trim().min(1).max(MAX_MENU_ITEM_PAYLOAD),
  }),
  z.object({
    type: z.literal("web_url"),
    title: titleSchema,
    // Instagram opens the link in its own browser and refuses plain http, so a
    // non-https URL is a menu item that silently does nothing when tapped.
    url: z
      .string()
      .trim()
      .url()
      .max(1000)
      .refine((value) => value.startsWith("https://"), "Use an https:// link"),
  }),
]);

const putSchema = z.object({
  instagramAccountId: accountIdSchema,
  // Meta rejects an empty menu, so clearing goes through DELETE rather than
  // through a PUT with nothing in it.
  items: z.array(itemSchema).min(1).max(MAX_PERSISTENT_MENU_ITEMS),
});

const deleteSchema = z.object({
  instagramAccountId: accountIdSchema,
});

export interface PersistentMenuResponse {
  account: { id: string; username: string };
  items: PersistentMenuItem[];
  /**
   * False when we could not read the live menu back from Meta. The UI shows the
   * section as write-only in that case rather than presenting an empty list as
   * though the account had no menu.
   */
  readable: boolean;
  maxItems: number;
}

/** The menu currently configured on one of the workspace's accounts. */
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

  const items = await getPersistentMenu(
    decryptToken(account.accessToken),
    account.instagramId
  );

  const data: PersistentMenuResponse = {
    account: { id: account.id, username: account.username },
    items: items ?? [],
    readable: items !== null,
    maxItems: MAX_PERSISTENT_MENU_ITEMS,
  };
  return NextResponse.json({ success: true, data });
}

/** Replace the whole menu. Meta has no partial update for this field. */
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
        error: "Only owners and admins can change the persistent menu",
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
        error: `Send between 1 and ${MAX_PERSISTENT_MENU_ITEMS} items, each with a label of up to ${MAX_MENU_ITEM_TITLE} characters and either an https link or a payload.`,
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
    await setPersistentMenu(
      decryptToken(account.accessToken),
      account.instagramId,
      parsed.data.items
    );
  } catch (err) {
    console.error("[PersistentMenu] Save error:", err);
    // Meta's own message is worth surfacing here. The usual failures are a
    // missing messaging permission or an expired token, both of which the user
    // has to act on themselves.
    const message =
      err instanceof MetaApiError
        ? err.message
        : "Failed to save the persistent menu";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }

  const data: PersistentMenuResponse = {
    account: { id: account.id, username: account.username },
    items: parsed.data.items,
    // Echoing back what we just wrote, not a fresh read from Meta.
    readable: true,
    maxItems: MAX_PERSISTENT_MENU_ITEMS,
  };
  return NextResponse.json({ success: true, data });
}

/** Remove the menu. Threads then show no hamburger menu for the account. */
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
        error: "Only owners and admins can change the persistent menu",
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
    await clearPersistentMenu(
      decryptToken(account.accessToken),
      account.instagramId
    );
  } catch (err) {
    console.error("[PersistentMenu] Clear error:", err);
    const message =
      err instanceof MetaApiError
        ? err.message
        : "Failed to clear the persistent menu";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
