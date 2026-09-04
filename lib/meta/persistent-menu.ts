/**
 * Instagram persistent menu.
 *
 * The persistent menu is the hamburger menu Instagram shows inside a DM
 * thread with the account. It is account-level, not per-campaign, and every
 * write replaces the whole menu, so callers send the full list rather than a
 * delta. This is the same `messenger_profile` endpoint the conversation
 * starters use, with a different field on it.
 *
 * Two Instagram-specific limits worth stating out loud, because they are the
 * ones people get wrong:
 *   - the menu does not update in real time inside conversations that are
 *     already open, and it cannot vary per person
 *   - `composer_input_disabled` and `webview_height_ratio` are Messenger-only.
 *     Sending either to Instagram is a rejected call, so this module never does
 */

import { handleResponse, instagramGraphBase } from "@/lib/meta/client";

/** Meta recommends no more than five items, so this is the ceiling we enforce. */
export const MAX_PERSISTENT_MENU_ITEMS = 5;

/**
 * Meta's documented ceiling for a menu item title. Titles are truncated here
 * rather than rejected, so a slightly long label still ships a working menu.
 */
export const MAX_MENU_ITEM_TITLE = 30;

/** The payload is ours, and only ever comes back to us as a postback. */
export const MAX_MENU_ITEM_PAYLOAD = 1000;

/**
 * One menu item. A postback item hands its payload back to us on tap, which is
 * how a menu answers an FAQ; a web_url item opens a link instead.
 */
export type PersistentMenuItem =
  | { type: "postback"; title: string; payload: string }
  | { type: "web_url"; title: string; url: string };

type MetaMenuAction =
  | { type: "postback"; title: string; payload: string }
  | { type: "web_url"; title: string; url: string };

function toMenuActions(items: PersistentMenuItem[]): MetaMenuAction[] {
  return items.slice(0, MAX_PERSISTENT_MENU_ITEMS).map((item) =>
    item.type === "web_url"
      ? {
          type: "web_url" as const,
          title: item.title.slice(0, MAX_MENU_ITEM_TITLE),
          url: item.url,
        }
      : {
          type: "postback" as const,
          title: item.title.slice(0, MAX_MENU_ITEM_TITLE),
          payload: item.payload,
        }
  );
}

type RawMenuAction = {
  type?: unknown;
  title?: unknown;
  payload?: unknown;
  url?: unknown;
};

/**
 * Normalise whatever Meta hands back into our own shape. Anything that is not
 * a postback or web_url item with the fields that type needs is dropped: an
 * item we cannot render is worse than one we do not show, because the editor
 * would save it back in a shape Meta then refuses.
 */
export function toPersistentMenuItems(raw: unknown): PersistentMenuItem[] {
  if (!Array.isArray(raw)) return [];

  const items: PersistentMenuItem[] = [];
  for (const entry of raw as RawMenuAction[]) {
    const title = typeof entry?.title === "string" ? entry.title : null;
    if (!title) continue;

    if (entry.type === "web_url" && typeof entry.url === "string") {
      items.push({ type: "web_url", title, url: entry.url });
      continue;
    }
    if (entry.type === "postback" && typeof entry.payload === "string") {
      items.push({ type: "postback", title, payload: entry.payload });
    }
  }
  return items;
}

/**
 * Read the menu currently live on the account.
 *
 * Returns null when Meta will not tell us, which is a different and much less
 * damaging claim than an empty list: the menu lives only on the Instagram
 * profile, we keep no mirror of it, so "we could not read it" must never be
 * presented as "there is no menu". The route turns a null into a write-only
 * editor rather than an empty one.
 */
export async function getPersistentMenu(
  accessToken: string,
  instagramAccountId: string
): Promise<PersistentMenuItem[] | null> {
  const url = new URL(
    `${instagramGraphBase()}/${instagramAccountId}/messenger_profile`
  );
  url.searchParams.set("platform", "instagram");
  url.searchParams.set("fields", "persistent_menu");
  url.searchParams.set("access_token", accessToken);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return null;

    const body: unknown = await response.json();
    const entries = (body as { data?: unknown })?.data;
    // An array is the success signal, including an empty one: Meta answers
    // `{"data":[]}` for a profile with the field genuinely unset.
    if (!Array.isArray(entries)) return null;

    const field = (entries as Array<{ persistent_menu?: unknown }>).find(
      (entry) => Array.isArray(entry?.persistent_menu)
    );
    if (!field) return [];

    // Instagram nests the items under a per-locale `call_to_actions` array, the
    // same way it nests ice breakers.
    const locales = field.persistent_menu as Array<{
      call_to_actions?: unknown;
    }>;
    const items: PersistentMenuItem[] = [];
    for (const locale of locales) {
      items.push(...toPersistentMenuItems(locale?.call_to_actions));
    }
    return items;
  } catch (err) {
    console.warn(
      "[PersistentMenu] Read unavailable:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Replace the account's whole menu. Meta has no partial update for this field,
 * so the caller sends every item it wants to keep.
 *
 * Throws a MetaApiError (or one of its subclasses) on a Meta failure, the same
 * as every other sender in lib/meta.
 */
export async function setPersistentMenu(
  accessToken: string,
  instagramAccountId: string,
  items: PersistentMenuItem[]
): Promise<{ result?: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messenger_profile`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        platform: "instagram",
        persistent_menu: [
          {
            locale: "default",
            call_to_actions: toMenuActions(items),
          },
        ],
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Remove the menu entirely. Deleting the field is not the same as setting an
 * empty list, which Meta rejects.
 */
export async function clearPersistentMenu(
  accessToken: string,
  instagramAccountId: string
): Promise<{ result?: string }> {
  const url = new URL(
    `${instagramGraphBase()}/${instagramAccountId}/messenger_profile`
  );
  url.searchParams.set("platform", "instagram");
  url.searchParams.set("fields", JSON.stringify(["persistent_menu"]));

  const response = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return handleResponse(response);
}
