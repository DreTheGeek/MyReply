import { inferAttachmentKind } from "@/lib/channels/content";
import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";
import {
  toMetaQuickReplies,
  type QuickReply,
} from "@/lib/meta/quick-replies";

// Exported so sibling modules (lib/meta/persistent-menu.ts) build their URLs
// from the same base rather than keeping a second copy of it.
export function instagramGraphBase() {
  return `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

export function facebookGraphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

export class MetaApiError extends Error {
  constructor(
    public code: number,
    public subcode: number | undefined,
    public fbTraceId: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

// These subclasses carry the subcode and the code Meta actually sent. The
// subcode is the only thing that separates a permanent rejection (a comment
// not eligible for a private reply, sub=2534025) from one worth retrying, and
// the fixed code made a 10 or a 200 arrive as a 100, which is what
// `isTemplateRejection` in the DM worker tests for before it tries another
// send. Both arguments default to the previous values, so existing call sites
// are unaffected.
export class TokenExpiredError extends MetaApiError {
  constructor(message: string, fbTraceId?: string, subcode?: number) {
    super(190, subcode, fbTraceId, message);
    this.name = "TokenExpiredError";
  }
}

export class RateLimitError extends MetaApiError {
  constructor(
    message: string,
    fbTraceId?: string,
    subcode?: number,
    code = 368
  ) {
    super(code, subcode, fbTraceId, message);
    this.name = "RateLimitError";
  }
}

export class PermissionError extends MetaApiError {
  constructor(
    message: string,
    fbTraceId?: string,
    subcode?: number,
    code = 100
  ) {
    super(code, subcode, fbTraceId, message);
    this.name = "PermissionError";
  }
}

interface GraphApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface InstagramUser {
  id: string;
  // Instagram professional account ID. This, not `id` (the app-scoped ID),
  // is what appears as entry.id in webhooks and is used by the messaging API.
  user_id?: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
  // Current follower total. Point-in-time only, Instagram exposes no history
  // for this field, so long-run trends come from FollowerSnapshot instead.
  followers_count?: number;
}

export interface InstagramComment {
  id: string;
  text: string;
  from?: {
    id: string;
    username?: string;
  };
  timestamp: string;
  // Present when the comments query asks for replies{from}. Used to tell whether
  // the account owner has already replied to this comment.
  replies?: {
    data?: { id: string; from?: { id: string; username?: string } }[];
  };
}

export interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
}

export interface InstagramMediaInsights {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  saved?: number;
  shares?: number;
  total_interactions?: number;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

// Exported so sibling modules classify Meta's failures identically. A second
// copy of this mapping would drift, and the error class is what callers switch
// on to tell an expired token from a missing permission.
export async function handleResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok || (data as GraphApiError).error) {
    const err = (data as GraphApiError).error;
    const code = err?.code ?? response.status;
    const subcode = err?.error_subcode;
    const traceId = err?.fbtrace_id;
    // Without the path a Meta error is unattributable: a connect runs several
    // calls in a row that fail with the identical message. The query string is
    // dropped on purpose, it carries the access token.
    let path = "";
    try {
      path = ` (${new URL(response.url).pathname})`;
    } catch {}
    const message = `${err?.message ?? "Unknown Meta API error"}${path} [code=${code} sub=${subcode ?? "-"} type=${err?.type ?? "-"} trace=${traceId ?? "-"}]`;

    switch (code) {
      case 190:
        throw new TokenExpiredError(message, traceId, subcode);
      case 368:
      case 4:
      case 17:
        throw new RateLimitError(message, traceId, subcode, code);
      case 10:
      case 100:
      case 200:
        throw new PermissionError(message, traceId, subcode, code);
      default:
        throw new MetaApiError(code, subcode, traceId, message);
    }
  }

  return data as T;
}

export async function sendPrivateReply(
  accessToken: string,
  instagramAccountId: string,
  commentId: string,
  message: string
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text: message },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a private reply to a comment as a button template, an opening message
 * plus a postback button. Tapping the button opens the conversation and fires
 * a `messaging_postbacks` webhook carrying `payload`, which we use to deliver
 * the follow-up ("reveal") message.
 */
export async function sendPrivateReplyWithButton(
  accessToken: string,
  instagramAccountId: string,
  commentId: string,
  text: string,
  buttonTitle: string,
  payload: string
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              // Button template text is capped at 640 chars by Meta.
              text: text.slice(0, 640),
              buttons: [
                { type: "postback", title: buttonTitle.slice(0, 20), payload },
              ],
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a direct message (to a user's IGSID) as a button template with a single
 * postback button. Used to re-prompt a user during follow-gating, so tapping
 * the button fires another `messaging_postbacks` webhook carrying `payload`.
 */
export async function sendDirectMessageWithButton(
  accessToken: string,
  instagramAccountId: string,
  userId: string,
  text: string,
  buttonTitle: string,
  payload: string
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: text.slice(0, 640),
              buttons: [
                { type: "postback", title: buttonTitle.slice(0, 20), payload },
              ],
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Check whether a user (by their IGSID) follows the business account, via the
 * Instagram Messaging profile API. Available for users in an active
 * conversation (e.g. after a private reply or a button tap). Returns true or
 * false, or `null` when Meta does not return the field, so callers can decide
 * how to treat the unverifiable case.
 */
export async function getUserFollowStatus(
  accessToken: string,
  recipientId: string
): Promise<boolean | null> {
  const url = new URL(`${instagramGraphBase()}/${recipientId}`);
  url.searchParams.set("fields", "is_user_follow_business");

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.is_user_follow_business === "boolean"
      ? data.is_user_follow_business
      : null;
  } catch {
    return null;
  }
}

/**
 * The handle behind an IGSID, for personalizing a message to someone who
 * messaged the account. The messages and postbacks webhooks carry only the
 * sender's id, unlike the comments webhook, which carries the username.
 *
 * Instagram answers this for anyone who has an open conversation with the
 * account, which is exactly who arrives on those two paths. null when the
 * handle cannot be read, so the caller falls back as before.
 */
export async function getUserUsername(
  accessToken: string,
  recipientId: string
): Promise<string | null> {
  const url = new URL(`${instagramGraphBase()}/${recipientId}`);
  url.searchParams.set("fields", "username");

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.username === "string" && data.username
      ? data.username
      : null;
  } catch {
    return null;
  }
}

/**
 * A tappable web_url button in a DM button template. Instagram's button
 * template supports up to 3 buttons; titles are capped at 20 chars by Meta.
 */
export interface LinkButton {
  title: string;
  url: string;
}

function toWebUrlButtons(buttons: LinkButton[]) {
  return buttons
    .slice(0, 3)
    .map((b) => ({ type: "web_url", url: b.url, title: b.title.slice(0, 20) }));
}

/**
 * Send a private reply to a comment as a button template with up to 3 web_url
 * buttons, the reveal message plus tappable link buttons (for campaigns with
 * no opening DM, where the reveal is delivered straight to the comment).
 */
export async function sendPrivateReplyWithLinkButton(
  accessToken: string,
  instagramAccountId: string,
  commentId: string,
  text: string,
  buttons: LinkButton[]
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: text.slice(0, 640),
              buttons: toWebUrlButtons(buttons),
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a plain-text direct message to a user by their Instagram-scoped ID.
 * Used to deliver the reveal message after a button postback.
 */
/**
 * What Instagram will carry as an attachment. `file` covers PDFs and other
 * documents; the rest are what their names suggest.
 */
export type AttachmentType = "image" | "video" | "audio" | "file";

/**
 * Send a file rather than text. Instagram fetches the URL itself, so it must
 * be publicly reachable: a signed URL that expires, or anything behind auth,
 * fails on Meta's side rather than ours.
 *
 * Sent as its own message because Instagram's send API carries either text or
 * an attachment, never both, so a caption is a second call.
 */
export async function sendAttachment(
  accessToken: string,
  instagramAccountId: string,
  userId: string,
  attachmentUrl: string,
  type: AttachmentType = "image"
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: {
          attachment: {
            type,
            // Reusable so a campaign sending the same lead magnet a thousand
            // times uploads it to Meta once instead of on every send.
            payload: { url: attachmentUrl, is_reusable: true },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Guess the attachment type from the URL's extension. Instagram rejects a
 * mismatched type, and campaign authors paste links rather than picking a
 * type, so infer it and default to file, which is the most permissive.
 */
export function inferAttachmentType(url: string): AttachmentType {
  return inferAttachmentKind(url);
}

export async function sendDirectMessage(
  accessToken: string,
  instagramAccountId: string,
  userId: string,
  message: string,
  options: { humanAgent?: boolean } = {}
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: { text: message },
        // A person replying from the inbox after the 24 hour window, inside
        // the 7 day human agent window. Only ever set by a human send, and
        // only once the app is approved for the Human Agent feature.
        ...(options.humanAgent
          ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
          : {}),
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a direct message with tappable quick replies underneath it.
 *
 * The buttons ride on the message itself rather than on an attachment, which is
 * the shape Instagram documents. On tap, Instagram posts the button's title to
 * the conversation as the user's own message and sends us a webhook carrying
 * that title and the button's payload.
 *
 * The list is capped at 13 and titles truncated to 20 characters by
 * toMetaQuickReplies, so a campaign with an over-long label sends a shortened
 * button instead of failing the whole DM.
 */
export async function sendDirectMessageWithQuickReplies(
  accessToken: string,
  instagramAccountId: string,
  userId: string,
  text: string,
  quickReplies: QuickReply[]
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: {
          text,
          quick_replies: toMetaQuickReplies(quickReplies),
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a private reply to a comment with quick replies underneath it.
 *
 * Same message shape as the direct-message sender, addressed to a comment
 * instead of a user. Note that Instagram allows exactly one private reply per
 * comment, ever, so a caller here has no second attempt if Meta refuses the
 * message: the DM worker deliberately keeps quick replies on the direct-message
 * path, where a rejected send can be retried.
 */
export async function sendPrivateReplyWithQuickReplies(
  accessToken: string,
  instagramAccountId: string,
  commentId: string,
  text: string,
  quickReplies: QuickReply[]
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: {
          text,
          quick_replies: toMetaQuickReplies(quickReplies),
        },
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Send a direct message as a button template with up to 3 web_url buttons,
 * the reveal message plus tappable link buttons (cleaner than inline URLs).
 */
export async function sendDirectMessageWithLinkButton(
  accessToken: string,
  instagramAccountId: string,
  userId: string,
  text: string,
  buttons: LinkButton[]
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: text.slice(0, 640),
              buttons: toWebUrlButtons(buttons),
            },
          },
        },
      }),
    }
  );

  return handleResponse(response);
}

export async function sendCommentReply(
  accessToken: string,
  commentId: string,
  message: string
): Promise<{ id: string }> {
  const response = await fetch(
    `${instagramGraphBase()}/${commentId}/replies`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ message }),
    }
  );

  return handleResponse(response);
}

/**
 * Hide a comment on the account's own media from everyone but its author, or
 * show it again. Needs instagram_business_manage_comments.
 */
export async function setCommentHidden(
  accessToken: string,
  commentId: string,
  hidden: boolean
): Promise<{ success?: boolean }> {
  const response = await fetch(`${instagramGraphBase()}/${commentId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ hide: hidden }),
  });
  return handleResponse(response);
}

export async function getMediaComments(
  accessToken: string,
  mediaId: string
): Promise<InstagramComment[]> {
  const url = new URL(`${instagramGraphBase()}/${mediaId}/comments`);
  url.searchParams.set("fields", "id,text,from,timestamp");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{ data: InstagramComment[] }>(response);
  return data.data;
}

/**
 * Recent comments on a media, newest first, each with its replies so the caller
 * can tell whether the account owner has already responded. Pagination stops as
 * soon as it reaches comments older than `sinceMs` (or the `max` ceiling), so a
 * viral post's entire back-catalogue is never pulled, only what is recent
 * enough to still act on. This is what the polling reconciler reads.
 *
 * Note: comments hidden by Instagram's Hidden Words / spam filter may not be
 * returned by the Graph API at all. Disable that filter on the account to widen
 * results.
 */
export async function getRecentMediaComments(
  accessToken: string,
  mediaId: string,
  sinceMs: number,
  max = 800
): Promise<InstagramComment[]> {
  const results: InstagramComment[] = [];

  const first = new URL(`${instagramGraphBase()}/${mediaId}/comments`);
  first.searchParams.set("fields", "id,text,timestamp,from,replies{from}");
  first.searchParams.set("order", "reverse_chronological");
  first.searchParams.set("limit", "50");
  first.searchParams.set("access_token", accessToken);

  let nextUrl: string | null = first.toString();

  while (nextUrl !== null && results.length < max) {
    const response: Response = await fetch(nextUrl);
    const page = await handleResponse<{
      data: InstagramComment[];
      paging?: { next?: string };
    }>(response);
    const data = page.data ?? [];
    results.push(...data);

    // Newest-first, so once the last item on a page predates the window there
    // is nothing older worth fetching.
    const oldest = data[data.length - 1];
    if (oldest?.timestamp && Date.parse(oldest.timestamp) < sinceMs) break;
    nextUrl = page.paging?.next ?? null;
  }

  return results
    .filter((c) => !c.timestamp || Date.parse(c.timestamp) >= sinceMs)
    .slice(0, max);
}

// --- Direct message inbox (Conversations API) ---------------------------

export interface InstagramParticipant {
  id: string;
  username?: string;
}

export interface InstagramMessage {
  id: string;
  created_time?: string;
  message?: string;
  from?: InstagramParticipant;
  to?: { data: InstagramParticipant[] };
}

export interface InstagramConversation {
  id: string;
  detailsUnavailable?: boolean;
  updated_time?: string;
  participants?: { data: InstagramParticipant[] };
  messages?: { data: InstagramMessage[] };
}

/**
 * Load up to 50 recent conversations. A single broken field expansion can make
 * Meta reject the entire page with code 1 (upstream issue #60). Halve only those
 * failing pages until the affected conversation is isolated, then retain its
 * basic metadata and advance using the OUTER conversation cursor.
 *
 * Healthy accounts still need just one request. Auth, permission, rate-limit,
 * transport and minimal-list failures remain visible rather than looking empty.
 */
export async function getConversations(
  accessToken: string,
  igUserId: string
): Promise<InstagramConversation[]> {
  const fields =
    "participants,updated_time,messages.limit(1){message,from,created_time}";
  type Page = {
    data?: InstagramConversation[];
    paging?: { next?: string; cursors?: { after?: string } };
  };
  const results: InstagramConversation[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | undefined;
  let pageSize = 50;

  async function readPage(limit: number, requestedFields: string): Promise<Page> {
    // Never follow Meta's next URL: rebuild on our trusted host and carry the
    // token separately. A messages.paging cursor must never advance this list.
    const url = new URL(`${instagramGraphBase()}/${igUserId}/conversations`);
    url.searchParams.set("platform", "instagram");
    url.searchParams.set("fields", requestedFields);
    url.searchParams.set("limit", String(limit));
    if (after) url.searchParams.set("after", after);
    return handleResponse<Page>(
      await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
    );
  }

  // Also bound cursor traversal in case Meta repeats data with changing cursors.
  for (let pages = 0; pages < 100 && results.length < 50; pages++) {
    let limit = Math.min(pageSize, 50 - results.length);
    let page: Page;
    let unavailable = false;
    while (true) {
      try {
        page = await readPage(limit, fields);
        break;
      } catch (error) {
        if (!(error instanceof MetaApiError) || error.code !== 1) throw error;
        if (limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          continue;
        }
        // This exact cursor succeeds with id,updated_time in the reported case.
        // If even that fails, propagate the failure; do not skip unknown data.
        page = await readPage(1, "id,updated_time");
        unavailable = true;
        console.warn("[Conversations] Detail expansion unavailable", {
          code: error.code,
          subcode: error.subcode,
          trace: error.fbTraceId,
        });
        break;
      }
    }

    const rows = page.data ?? [];
    for (const row of rows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      results.push(unavailable ? { ...row, detailsUnavailable: true } : row);
      if (results.length === 50) return results;
    }
    if (!page.paging?.next || rows.length === 0) return results;
    const nextAfter = page.paging.cursors?.after;
    if (!nextAfter || seenCursors.has(nextAfter)) {
      throw new Error("Instagram conversation pagination did not advance");
    }
    seenCursors.add(nextAfter);
    after = nextAfter;
    // Stay small around failures; grow back towards the normal page size after
    // successful expansions. Consecutive bad entries cost two reads each.
    pageSize = unavailable ? 1 : Math.min(50, limit * 2);
  }
  throw new Error("Instagram conversation pagination exceeded its safety limit");
}

/**
 * The messages in a conversation, with content. Meta only returns full details
 * for the 20 most recent messages, newest first.
 */
export async function getConversationMessages(
  accessToken: string,
  conversationId: string
): Promise<InstagramMessage[]> {
  const url = new URL(`${instagramGraphBase()}/${conversationId}`);
  url.searchParams.set("fields", "messages{id,created_time,from,to,message}");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{ messages?: { data: InstagramMessage[] } }>(
    response
  );
  return data.messages?.data ?? [];
}

export async function getUserInfo(accessToken: string): Promise<InstagramUser> {
  const url = new URL(`${instagramGraphBase()}/me`);
  url.searchParams.set(
    "fields",
    "id,user_id,username,name,profile_picture_url,followers_count"
  );
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  return handleResponse<InstagramUser>(response);
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,timestamp,permalink,like_count,comments_count";

// Instagram caps a single media page at 100 items.
const MEDIA_PAGE_SIZE = 100;

export async function getUserMedia(
  accessToken: string,
  limit = 25
): Promise<InstagramMedia[]> {
  const url = new URL(`${instagramGraphBase()}/me/media`);
  url.searchParams.set("fields", MEDIA_FIELDS);
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{ data: InstagramMedia[] }>(response);
  return data.data;
}

/**
 * Fetch media by following pagination cursors until `max` items are collected
 * or there are no more pages. Pass a large `max` for an "all time" view; the
 * cap is a safety ceiling so an account with thousands of posts can't spin
 * forever (and so downstream per-media insight calls stay bounded).
 */
export async function getAllUserMedia(
  accessToken: string,
  max = 500
): Promise<InstagramMedia[]> {
  const results: InstagramMedia[] = [];

  const first = new URL(`${instagramGraphBase()}/me/media`);
  first.searchParams.set("fields", MEDIA_FIELDS);
  first.searchParams.set("limit", String(Math.min(MEDIA_PAGE_SIZE, max)));
  first.searchParams.set("access_token", accessToken);

  let nextUrl: string | null = first.toString();

  while (nextUrl !== null && results.length < max) {
    const response: Response = await fetch(nextUrl);
    const page = await handleResponse<{
      data: InstagramMedia[];
      paging?: { next?: string };
    }>(response);
    results.push(...page.data);
    nextUrl = page.paging?.next ?? null;
  }

  return results.slice(0, max);
}

/**
 * Fetch per-media insight metrics (views, reach, saved, shares, etc.).
 *
 * Requires the `instagram_business_manage_insights` permission, accounts
 * connected before that scope was requested will throw a PermissionError.
 * Metric validity varies by media type, so pass only metrics that apply to
 * the given media (e.g. `views` is not valid for image posts on some accounts).
 */
export async function getMediaInsights(
  accessToken: string,
  mediaId: string,
  metrics: string[]
): Promise<InstagramMediaInsights> {
  const url = new URL(`${instagramGraphBase()}/${mediaId}/insights`);
  url.searchParams.set("metric", metrics.join(","));
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    data: Array<{ name: string; values: Array<{ value: number }> }>;
  }>(response);

  const result: InstagramMediaInsights = {};
  for (const entry of data.data) {
    result[entry.name as keyof InstagramMediaInsights] =
      entry.values?.[0]?.value ?? 0;
  }
  return result;
}

/** One day of net follower change, as reported by account insights. */
export interface FollowerCountPoint {
  /** ISO date (YYYY-MM-DD) the change is attributed to. */
  date: string;
  /** Net followers gained (or lost, if negative) that day. */
  delta: number;
}

// Instagram only retains ~30 days of account insights, and rejects windows
// wider than 30 days outright. Stay just inside the limit.
const FOLLOWER_INSIGHT_MAX_DAYS = 30;

/**
 * Fetch the daily net follower change for an account.
 *
 * Requires `instagram_business_manage_insights`. Note this metric is *not*
 * universally available: Instagram omits it for accounts under 100 followers
 * and it is unsupported on some account types. Callers must treat `null` as
 * "no series available" rather than an error, see the backfill in
 * `lib/reports/follower-history.ts`.
 *
 * Returns daily deltas, not running totals. Reconstruct absolute counts by
 * anchoring on a known `followers_count` and walking backwards.
 */
export async function getFollowerCountSeries(
  accessToken: string,
  instagramAccountId: string,
  days: number = FOLLOWER_INSIGHT_MAX_DAYS
): Promise<FollowerCountPoint[] | null> {
  const span = Math.min(Math.max(days, 1), FOLLOWER_INSIGHT_MAX_DAYS);
  const until = Math.floor(Date.now() / 1000);
  const since = until - (span - 1) * 86_400;

  const url = new URL(`${instagramGraphBase()}/${instagramAccountId}/insights`);
  url.searchParams.set("metric", "follower_count");
  url.searchParams.set("period", "day");
  url.searchParams.set("since", String(since));
  url.searchParams.set("until", String(until));
  url.searchParams.set("access_token", accessToken);

  try {
    const response = await fetch(url.toString());
    const data = await handleResponse<{
      data: Array<{
        name: string;
        values: Array<{ value: number; end_time?: string }>;
      }>;
    }>(response);

    const metric = data.data.find((d) => d.name === "follower_count");
    if (!metric?.values?.length) return null;

    return metric.values.map((v) => ({
      date: (v.end_time ?? new Date().toISOString()).slice(0, 10),
      delta: v.value ?? 0,
    }));
  } catch (err) {
    // A missing permission is a real signal the caller may want to surface;
    // anything else here means the metric is simply unavailable for this
    // account, which is not worth failing the whole dashboard over.
    if (err instanceof PermissionError) throw err;
    console.warn(
      "[Instagram] follower_count insights unavailable:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function getLongLivedToken(
  shortLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${instagramGraphBase()}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", requireEnv("INSTAGRAM_APP_SECRET"));
  url.searchParams.set("access_token", shortLivedToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<TokenResponse>(response);

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 5184000,
  };
}

export async function refreshLongLivedToken(
  longLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${instagramGraphBase()}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", longLivedToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<TokenResponse>(response);

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 5184000,
  };
}

/**
 * Every webhook field the app parses.
 *
 * This list previously held only comments and messages, while the webhook
 * parser handled six more. Meta delivers only what the account is explicitly
 * subscribed to, so Live comment triggers, referral arrivals, mentions and
 * reactions were being parsed by code that never received an event. Anything
 * added to lib/meta/webhook.ts must be added here too or it is dead on arrival.
 *
 * Names are exact. Meta rejects the whole call if one is wrong, and it is
 * message_edit rather than message_edits.
 */
export const WEBHOOK_FIELDS = [
  "comments",
  "live_comments",
  "messages",
  "messaging_postbacks",
  "messaging_referral",
  "messaging_seen",
  "message_reactions",
  "message_edit",
  "mentions",
] as const;

export async function subscribeInstagramAccountToWebhooks(
  instagramAccountId: string,
  accessToken: string
): Promise<{ success: boolean }> {
  const response = await fetch(
    `${instagramGraphBase()}/${instagramAccountId}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        subscribed_fields: WEBHOOK_FIELDS,
      }),
    }
  );

  const result = await handleResponse<{ success?: boolean }>(response);

  // Meta answers a refused subscription with HTTP 200 and {"success": false},
  // so the status code alone reports a silent no-op as a success. That is how
  // this account ran for weeks subscribed to two fields while the code believed
  // it had asked for nine. A field the app is not approved for (follow and
  // share_to_story are both valid names but gated) fails the whole call, so
  // this has to be loud.
  if (result?.success === false) {
    throw new MetaApiError(
      0,
      undefined,
      undefined,
      "Instagram refused the webhook subscription. One of the requested fields is not available to this app."
    );
  }

  return { success: true };
}

export interface ConversationStarter {
  /** Shown as a tappable prompt when someone opens a fresh DM thread. */
  question: string;
  /** Echoed back as a postback payload when tapped. */
  payload: string;
}

/**
 * Set the prompts Instagram shows someone opening a conversation for the first
 * time. Account-level rather than per-campaign, and replaces the whole set on
 * every call, so callers send the full list rather than a delta.
 *
 * Meta caps these at four.
 */
export async function setConversationStarters(
  accessToken: string,
  instagramAccountId: string,
  starters: ConversationStarter[]
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
        ice_breakers: starters.slice(0, 4).map((starter) => ({
          question: starter.question,
          payload: starter.payload,
        })),
      }),
    }
  );

  return handleResponse(response);
}

/**
 * Clear every conversation starter. Deleting the field is not the same as
 * setting an empty list, which Meta rejects.
 */
export async function clearConversationStarters(
  accessToken: string,
  instagramAccountId: string
): Promise<{ result?: string }> {
  const url = new URL(
    `${instagramGraphBase()}/${instagramAccountId}/messenger_profile`
  );
  url.searchParams.set("platform", "instagram");
  url.searchParams.set("fields", JSON.stringify(["ice_breakers"]));

  const response = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return handleResponse(response);
}

export async function debugToken(inputToken: string, accessToken: string) {
  const url = new URL(`${facebookGraphBase()}/debug_token`);
  url.searchParams.set("input_token", inputToken);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url.toString());
  return handleResponse(response);
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
 */
export async function getConversationStarters(
  accessToken: string,
  instagramAccountId: string
): Promise<ConversationStarter[] | null> {
  const url = new URL(
    `${instagramGraphBase()}/${instagramAccountId}/messenger_profile`
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
