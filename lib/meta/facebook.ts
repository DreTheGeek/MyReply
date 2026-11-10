import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";
import { facebookGraphBase, handleResponse } from "@/lib/meta/client";
import { toMetaQuickReplies, type QuickReply } from "@/lib/meta/quick-replies";

/**
 * Facebook Pages and Messenger, through the Graph API.
 *
 * Every call here acts as one Page with that Page's access token, sent in the
 * Authorization header and never in a URL, so it cannot end up in a proxy or
 * request log. Errors come back through the same handleResponse as Instagram,
 * so a refusal, an expired token or a rate limit is the same error class on
 * either platform.
 *
 * Permissions, from Meta's current docs (see docs/review/meta.md):
 *   pages_show_list        list the Pages the person manages, at connect
 *   pages_manage_metadata  subscribe the Page to webhooks (feed, messages)
 *   pages_messaging        send messages and private replies
 *   pages_read_user_content read comments people leave on the Page
 *   pages_manage_engagement reply to and hide comments as the Page
 *   pages_read_engagement  read the Page's own posts
 *   business_management    required by the Messenger use case
 */

const SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_engagement",
  "business_management",
];

/** The webhook fields a connected Page is subscribed to. */
export const PAGE_WEBHOOK_FIELDS = [
  "feed",
  "messages",
  "messaging_postbacks",
  "message_reads",
  "message_echoes",
  "message_edits",
  "message_reactions",
  "messaging_referrals",
];

function authHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function graphGet<T>(
  token: string,
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${facebookGraphBase()}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return handleResponse<T>(await fetch(url.toString(), { headers: authHeaders(token) }));
}

async function graphPost<T>(token: string, path: string, body: unknown): Promise<T> {
  return handleResponse<T>(
    await fetch(`${facebookGraphBase()}${path}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    })
  );
}

async function graphDelete<T>(token: string, path: string, body: unknown): Promise<T> {
  return handleResponse<T>(
    await fetch(`${facebookGraphBase()}${path}`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    })
  );
}

// ─── Connecting ─────────────────────────────────────────────────────────────

export function getFacebookAuthorizationUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("FACEBOOK_APP_ID"),
    redirect_uri: redirectUri,
    scope: SCOPES.join(","),
    response_type: "code",
    state,
  });
  return `https://www.facebook.com/${getMetaGraphApiVersion()}/dialog/oauth?${params.toString()}`;
}

/** Trade the code for a long-lived user token, which is what Page tokens derive from. */
export async function exchangeFacebookCode(
  code: string,
  redirectUri: string
): Promise<string> {
  const shortParams = new URLSearchParams({
    client_id: requireEnv("FACEBOOK_APP_ID"),
    client_secret: requireEnv("FACEBOOK_APP_SECRET"),
    redirect_uri: redirectUri,
    code,
  });
  const short = await handleResponse<{ access_token: string }>(
    await fetch(`${facebookGraphBase()}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: shortParams.toString(),
    })
  );

  const longParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: requireEnv("FACEBOOK_APP_ID"),
    client_secret: requireEnv("FACEBOOK_APP_SECRET"),
    fb_exchange_token: short.access_token,
  });
  const long = await handleResponse<{ access_token: string }>(
    await fetch(`${facebookGraphBase()}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: longParams.toString(),
    })
  );
  return long.access_token;
}

export interface ManagedPage {
  id: string;
  name: string;
  /** A Page token derived from a long-lived user token does not expire. */
  access_token: string;
  tasks?: string[];
}

/** The Pages the person granted, each with its own Page token. */
export async function listManagedPages(userToken: string): Promise<ManagedPage[]> {
  const result = await graphGet<{ data?: ManagedPage[] }>(userToken, "/me/accounts", {
    fields: "id,name,access_token,tasks",
    limit: "100",
  });
  return result.data ?? [];
}

export async function subscribePageToWebhooks(
  pageId: string,
  pageToken: string
): Promise<boolean> {
  const result = await graphPost<{ success?: boolean }>(
    pageToken,
    `/${pageId}/subscribed_apps`,
    { subscribed_fields: PAGE_WEBHOOK_FIELDS.join(",") }
  );
  return Boolean(result.success);
}

// ─── Sending ────────────────────────────────────────────────────────────────

export type PageRecipient = { id: string } | { comment_id: string };

export interface PageLinkButton {
  title: string;
  url: string;
}

/** The `message` object of a Send API call, in each shape the adapter uses. */
export type PageMessage =
  | { kind: "text"; text: string; quickReplies?: QuickReply[] }
  | { kind: "postback_button"; text: string; title: string; payload: string }
  | { kind: "link_buttons"; text: string; buttons: PageLinkButton[] }
  | { kind: "attachment"; url: string; type: "image" | "video" | "audio" | "file" };

function toMessageBody(message: PageMessage): Record<string, unknown> {
  switch (message.kind) {
    case "text":
      return {
        text: message.text,
        ...(message.quickReplies?.length
          ? { quick_replies: toMetaQuickReplies(message.quickReplies) }
          : {}),
      };
    case "postback_button":
      return {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: message.text.slice(0, 640),
            buttons: [
              { type: "postback", title: message.title.slice(0, 20), payload: message.payload },
            ],
          },
        },
      };
    case "link_buttons":
      return {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: message.text.slice(0, 640),
            buttons: message.buttons
              .slice(0, 3)
              .map((b) => ({ type: "web_url", url: b.url, title: b.title.slice(0, 20) })),
          },
        },
      };
    case "attachment":
      return {
        attachment: { type: message.type, payload: { url: message.url, is_reusable: true } },
      };
  }
}

/**
 * One Send API call as the Page. A `comment_id` recipient is a private reply
 * to that comment's author; an `id` recipient is a message in an open
 * conversation. `humanAgent` sends under the human agent tag.
 */
export async function sendPageMessage(
  pageToken: string,
  pageId: string,
  recipient: PageRecipient,
  message: PageMessage,
  options: { humanAgent?: boolean } = {}
): Promise<{ recipient_id?: string; message_id?: string }> {
  return graphPost(pageToken, `/${pageId}/messages`, {
    recipient,
    message: toMessageBody(message),
    ...(options.humanAgent
      ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
      : { messaging_type: "RESPONSE" }),
  });
}

/** Reply under a comment, publicly, as the Page. */
export async function replyToPageComment(
  pageToken: string,
  commentId: string,
  text: string
): Promise<{ id: string }> {
  return graphPost(pageToken, `/${commentId}/comments`, { message: text });
}

/** Hide a comment from everyone but its author, or show it again. */
export async function setPageCommentHidden(
  pageToken: string,
  commentId: string,
  hidden: boolean
): Promise<{ success?: boolean }> {
  return graphPost(pageToken, `/${commentId}`, { is_hidden: hidden });
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface PageProfile {
  id: string;
  name: string;
  username?: string;
  followers_count?: number;
  fan_count?: number;
  picture?: { data?: { url?: string } };
}

export async function getPageProfile(pageToken: string, pageId: string): Promise<PageProfile> {
  return graphGet(pageToken, `/${pageId}`, {
    fields: "id,name,username,followers_count,fan_count,picture{url}",
  });
}

export interface PagePost {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  status_type?: string;
  shares?: { count?: number };
  comments?: { summary?: { total_count?: number } };
  reactions?: { summary?: { total_count?: number } };
  attachments?: { data?: Array<{ media_type?: string; type?: string }> };
}

const POST_FIELDS =
  "id,message,created_time,permalink_url,full_picture,status_type,attachments{media_type,type},comments.limit(0).summary(true),reactions.limit(0).summary(true)";

export async function getPagePosts(
  pageToken: string,
  pageId: string,
  limit: number
): Promise<PagePost[]> {
  const result = await graphGet<{ data?: PagePost[] }>(pageToken, `/${pageId}/posts`, {
    fields: POST_FIELDS,
    limit: String(Math.min(Math.max(limit, 1), 100)),
  });
  return result.data ?? [];
}

/** Newest first, following paging until `max`. */
export async function getAllPagePosts(
  pageToken: string,
  pageId: string,
  max: number
): Promise<PagePost[]> {
  const posts: PagePost[] = [];
  let next: string | undefined = `${facebookGraphBase()}/${pageId}/posts?${new URLSearchParams({
    fields: POST_FIELDS,
    limit: "100",
  }).toString()}`;
  while (next && posts.length < max) {
    const page: { data?: PagePost[]; paging?: { next?: string } } = await handleResponse(
      await fetch(next, { headers: authHeaders(pageToken) })
    );
    posts.push(...(page.data ?? []));
    next = page.paging?.next;
  }
  return posts.slice(0, max);
}

export interface PageComment {
  id: string;
  message?: string;
  created_time: string;
  from?: { id: string; name?: string };
  comments?: { data?: Array<{ id: string; from?: { id: string } }> };
}

export async function getRecentPostComments(
  pageToken: string,
  postId: string,
  sinceMs: number,
  max: number
): Promise<PageComment[]> {
  const result = await graphGet<{ data?: PageComment[] }>(pageToken, `/${postId}/comments`, {
    fields: "id,message,created_time,from,comments{from}",
    filter: "toplevel",
    order: "reverse_chronological",
    limit: String(Math.min(max, 100)),
    since: String(Math.floor(sinceMs / 1000)),
  });
  return result.data ?? [];
}

/** A person's display name by their Page-scoped id, or null. */
export async function getPageScopedName(
  pageToken: string,
  psid: string
): Promise<string | null> {
  try {
    const result = await graphGet<{ name?: string }>(pageToken, `/${psid}`, { fields: "name" });
    return result.name ?? null;
  } catch {
    // The Business Asset User Profile Access feature gates this read. A Page
    // without it still sends; the message just uses its fallback greeting.
    return null;
  }
}

export interface PageConversation {
  id: string;
  updated_time?: string;
  participants?: { data?: Array<{ id: string; name?: string }> };
  messages?: { data?: PageConversationMessage[] };
}

export interface PageConversationMessage {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id: string; name?: string };
}

export async function getPageConversations(
  pageToken: string,
  pageId: string
): Promise<PageConversation[]> {
  const result = await graphGet<{ data?: PageConversation[] }>(
    pageToken,
    `/${pageId}/conversations`,
    {
      platform: "messenger",
      fields: "id,updated_time,participants,messages.limit(1){id,message,created_time,from}",
      limit: "50",
    }
  );
  return result.data ?? [];
}

export async function getPageConversationMessages(
  pageToken: string,
  conversationId: string
): Promise<PageConversationMessage[]> {
  const result = await graphGet<{ messages?: { data?: PageConversationMessage[] } }>(
    pageToken,
    `/${conversationId}`,
    { fields: "messages.limit(20){id,message,created_time,from}" }
  );
  return result.messages?.data ?? [];
}

// ─── Messenger profile: ice breakers and the persistent menu ────────────────

export interface PageIceBreaker {
  question: string;
  payload: string;
}

export type PageMenuItem =
  | { type: "postback"; title: string; payload: string }
  | { type: "web_url"; title: string; url: string };

type ProfileField = "ice_breakers" | "persistent_menu";

async function readProfileField(pageToken: string, field: ProfileField): Promise<unknown[] | null> {
  try {
    const result = await graphGet<{ data?: Array<Record<string, unknown>> }>(
      pageToken,
      "/me/messenger_profile",
      { fields: field }
    );
    if (!Array.isArray(result.data)) return null;
    const entry = result.data.find((item) => Array.isArray(item[field]));
    return entry ? (entry[field] as unknown[]) : [];
  } catch {
    return null;
  }
}

/** Messenger nests both settings under a per-locale entry; this reads either shape. */
export async function getPageIceBreakers(pageToken: string): Promise<PageIceBreaker[] | null> {
  const raw = await readProfileField(pageToken, "ice_breakers");
  if (raw === null) return null;
  const out: PageIceBreaker[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const nested = Array.isArray(item.call_to_actions) ? item.call_to_actions : [item];
    for (const entry of nested as Array<Record<string, unknown>>) {
      if (typeof entry.question === "string" && typeof entry.payload === "string") {
        out.push({ question: entry.question, payload: entry.payload });
      }
    }
  }
  return out;
}

export async function setPageIceBreakers(pageToken: string, items: PageIceBreaker[]): Promise<void> {
  await graphPost(pageToken, "/me/messenger_profile", {
    ice_breakers: [{ locale: "default", call_to_actions: items }],
  });
}

export async function getPagePersistentMenu(pageToken: string): Promise<PageMenuItem[] | null> {
  const raw = await readProfileField(pageToken, "persistent_menu");
  if (raw === null) return null;
  const out: PageMenuItem[] = [];
  for (const locale of raw as Array<{ call_to_actions?: Array<Record<string, unknown>> }>) {
    for (const item of locale.call_to_actions ?? []) {
      if (item.type === "postback" && typeof item.title === "string" && typeof item.payload === "string") {
        out.push({ type: "postback", title: item.title, payload: item.payload });
      } else if (item.type === "web_url" && typeof item.title === "string" && typeof item.url === "string") {
        out.push({ type: "web_url", title: item.title, url: item.url });
      }
    }
  }
  return out;
}

export async function setPagePersistentMenu(pageToken: string, items: PageMenuItem[]): Promise<void> {
  await graphPost(pageToken, "/me/messenger_profile", {
    persistent_menu: [
      { locale: "default", composer_input_disabled: false, call_to_actions: items },
    ],
  });
}

export async function clearPageProfileField(pageToken: string, field: ProfileField): Promise<void> {
  await graphDelete(pageToken, "/me/messenger_profile", { fields: [field] });
}
