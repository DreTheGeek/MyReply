import { createHmac, timingSafeEqual } from "crypto";

export function verifyWebhookSignature(
  payload: string,
  signature: string | null
): boolean {
  if (!signature) return false;

  // Instagram-Login apps sign webhooks with the Instagram app secret, while
  // Facebook-Login apps use the Facebook app secret. Both belong to the same
  // app, so accept a signature that matches either. This avoids a config
  // guess about which key Meta uses for a given app type.
  const secrets = [
    process.env.FACEBOOK_APP_SECRET,
    process.env.INSTAGRAM_APP_SECRET,
  ].filter((s): s is string => Boolean(s));

  if (secrets.length === 0) {
    throw new Error(
      "FACEBOOK_APP_SECRET or INSTAGRAM_APP_SECRET is required to verify webhooks"
    );
  }

  return secrets.some((secret) => {
    const expected =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

export interface WebhookCommentEvent {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
}

/**
 * The value object on a `changes` entry. Meta is inconsistent about which keys
 * it fills, so every reader here tolerates the documented aliases rather than
 * assuming one shape.
 */
interface WebhookChangeValue {
  id?: string;
  comment_id?: string;
  text?: string;
  from?: {
    id?: string;
    username?: string;
  };
  media?: {
    id?: string;
  };
  media_id?: string;
  // Markers Meta uses when a mention is folded into a `comments` notification
  // rather than delivered on its own `mentions` field. See parseMentionEvents.
  item?: string;
  is_mention?: boolean;
}

interface WebhookEntry {
  id: string;
  time: number;
  changes?: Array<{
    field: string;
    value: WebhookChangeValue;
  }>;
  messaging?: Array<{
    // Milliseconds since the epoch, stamped by Meta when the event happened.
    timestamp?: number;
    sender?: { id?: string };
    recipient?: { id?: string };
    postback?: { mid?: string; title?: string; payload?: string; referral?: { ref?: string } };
    read?: { watermark?: number; seq?: number };
    // A reaction placed on, or removed from, a message we delivered.
    reaction?: {
      mid?: string;
      action?: string;
      reaction?: string;
      emoji?: string;
    };
    // A correction the sender made to a message they already sent. Carries the
    // original mid, so it is the same message, not a new one.
    message_edit?: { mid?: string; text?: string; num_edit?: number };
    // Present when the user arrived through an ig.me link, QR code or website
    // button carrying a ref parameter, rather than by messaging directly.
    referral?: { ref?: string; source?: string; type?: string };
    message?: {
      mid?: string;
      text?: string;
      is_echo?: boolean;
      is_deleted?: boolean;
      is_unsupported?: boolean;
      // Instagram delivers a story reply as an ordinary message that also
      // carries the story it replies to, and a story mention as an attachment
      // with no text at all.
      reply_to?: { story?: { id?: string; url?: string }; mid?: string };
      // A quick reply tap arrives as an ordinary message carrying the button
      // title as its text, plus the payload we attached when we sent it.
      quick_reply?: { payload?: string };
      attachments?: Array<{ type?: string; payload?: { url?: string } }>;
    };
  }>;
}

/**
 * How an inbound message reached us. Instagram sends all three down the same
 * messaging channel, so the distinction is ours to draw: without it a story
 * reply is indistinguishable from someone typing into your DMs, and a campaign
 * cannot target one without catching the other.
 */
export type MessageKind = "dm" | "story_reply" | "story_mention";

export interface WebhookMessageEvent {
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
  kind: MessageKind;
  /** The story replied to or mentioned in, when the kind is story-related. */
  storyId?: string;
  storyUrl?: string;
  /**
   * Set when the message is a quick reply tap rather than typed text. Instagram
   * posts the button title into the thread as the user's message, so without
   * this the tap is indistinguishable from someone typing that title.
   */
  quickReplyPayload?: string;
}

export interface WebhookLiveCommentEvent {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
}

export interface WebhookReferralEvent {
  instagramAccountId: string;
  userId: string;
  ref: string;
  source?: string;
}

export interface WebhookPostbackEvent {
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
}

export interface WebhookReadEvent {
  instagramAccountId: string;
  userId: string;
  watermark?: number;
}

/**
 * A message the connected account sent, echoed back to us. Instagram echoes
 * every outbound message on the same channel as inbound ones, including
 * messages a human typed into the native Instagram app. Without these, MyReply
 * has no record of a reply it did not send itself, and a thread an operator
 * answered on their phone still reads as unanswered.
 */
export interface WebhookMessageEchoEvent {
  instagramAccountId: string;
  /** Meta's message id. One per real message, so it is the natural dedup key. */
  messageId: string;
  messageText: string;
  /** IGSID of the person the message went to. */
  recipientId: string;
  /** When Meta says the message was sent. Absent on payloads without a stamp. */
  sentAt?: Date;
}

/**
 * A correction to a message that was already delivered. The mid is the original
 * message's, so this is the same message with new text, which is exactly why it
 * has to be re-evaluated: the first `messages` event carried the typo and
 * matched nothing.
 */
export interface WebhookMessageEditEvent {
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
  /** Meta's edit counter for this message. 1 is the first correction. */
  numEdit: number;
}

/** Placing or removing a reaction on a message the account delivered. */
export type ReactionAction = "react" | "unreact";

export interface WebhookReactionEvent {
  instagramAccountId: string;
  userId: string;
  /** The message that was reacted to, not a new message of its own. */
  messageId: string;
  action: ReactionAction;
  /** Meta's name for the reaction, for example "love". */
  reaction?: string;
  emoji?: string;
}

/**
 * Where the account was tagged. A caption mention is someone naming the account
 * in their own post; a comment mention is someone naming it in a comment,
 * usually on media the account does not own.
 */
export type MentionSurface = "caption" | "comment";

export interface WebhookMentionEvent {
  instagramAccountId: string;
  mediaId: string;
  /** Set only for a comment mention. */
  commentId?: string;
  /** Present only when Meta names the author. Many mention payloads do not. */
  mentionerId?: string;
  mentionerName?: string;
  surface: MentionSurface;
  /** Which of Meta's two delivery shapes this arrived on. */
  deliveredOn: "mentions" | "comments";
}

/**
 * True when a `comments` change is actually a mention notification.
 *
 * Meta's own documentation disagrees with itself about whether an Instagram
 * Login app receives mentions on a dedicated `mentions` field or folded into
 * `comments`. Rather than bet on one, we detect the explicit markers Meta sets
 * when it folds them in and leave every other `comments` change alone. An
 * unmarked comment is still a comment, so ordinary comment handling is
 * unchanged and nothing is processed twice.
 */
function isMentionChange(value: WebhookChangeValue | undefined): boolean {
  if (!value) return false;
  return value.item === "mention" || value.is_mention === true;
}

interface WebhookPayload {
  object: string;
  entry: WebhookEntry[];
}

export function parseCommentEvents(payload: WebhookPayload): WebhookCommentEvent[] {
  const events: WebhookCommentEvent[] = [];

  if (payload.object !== "instagram") {
    return events;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;

      const value = change.value;

      // A mention that Meta folded into a comments notification is not a
      // comment on our own media, so the private reply this path would queue
      // cannot be delivered. parseMentionEvents picks it up instead.
      if (isMentionChange(value)) continue;

      const commentId = value?.id ?? value?.comment_id;
      const mediaId = value?.media?.id ?? value?.media_id;
      const commenterId = value?.from?.id;

      if (!entry.id || !commentId || !mediaId || !commenterId) {
        continue;
      }

      // Skip the connected account's own comments and comment replies.
      // A private reply to yourself is rejected by Meta, so queueing one
      // only produces a failed log and wasted retries.
      if (commenterId === entry.id) {
        continue;
      }

      events.push({
        instagramAccountId: entry.id,
        commentId,
        commentText: value.text ?? "",
        commenterId,
        commenterName: value.from?.username,
        mediaId,
      });
    }
  }

  return events;
}

/**
 * Parse button-tap postbacks (from an opening DM's button) out of a webhook
 * payload. Each event carries the tapping user's IGSID and our postback payload.
 */
export function parsePostbackEvents(
  payload: WebhookPayload
): WebhookPostbackEvent[] {
  const events: WebhookPostbackEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const postbackPayload = messaging.postback?.payload;
      const userId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!postbackPayload || !userId || !accountId) continue;
      // Ignore echoes of the account's own actions.
      if (userId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        userId,
        payload: postbackPayload,
        mid: messaging.postback?.mid,
      });
    }
  }

  return events;
}

/**
 * Parse inbound Instagram DMs out of a webhook payload. These drive the
 * keyword-triggered autoreply: a user messages the account, and a campaign
 * with `dmTriggerEnabled` whose keywords match the text replies to them.
 *
 * Echoes (messages the account itself sent, including our own autoreplies),
 * deletions, and attachment-only messages with no text are dropped here so
 * the worker never sees them. An echo would otherwise let an autoreply
 * containing its own keyword trigger itself.
 */
export function parseMessageEvents(
  payload: WebhookPayload
): WebhookMessageEvent[] {
  const events: WebhookMessageEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const message = messaging.message;
      if (!message) continue;
      if (message.is_echo || message.is_deleted || message.is_unsupported) {
        continue;
      }

      const text = message.text?.trim();
      const messageId = message.mid;
      const senderId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!messageId || !senderId || !accountId) continue;
      // Ignore anything the connected account sent to itself.
      if (senderId === accountId) continue;

      const mentionAttachment = message.attachments?.find(
        (attachment) => attachment.type === "story_mention"
      );
      const repliedStory = message.reply_to?.story;

      let kind: MessageKind = "dm";
      if (mentionAttachment) {
        kind = "story_mention";
      } else if (repliedStory) {
        kind = "story_reply";
      }

      // A story mention carries no text at all, so the usual "text or drop"
      // rule would discard it. Every other kind still needs words to match on.
      if (!text && kind !== "story_mention") continue;

      events.push({
        instagramAccountId: accountId,
        messageId,
        messageText: text ?? "",
        senderId,
        kind,
        quickReplyPayload: message.quick_reply?.payload,
        storyId: repliedStory?.id,
        storyUrl: repliedStory?.url ?? mentionAttachment?.payload?.url,
      });
    }
  }

  return events;
}

/**
 * Parse echoes of messages the connected account sent.
 *
 * This is the mirror of parseMessageEvents, which drops echoes so an autoreply
 * can never trigger itself. Echoes still matter, they are just not a trigger:
 * they are the only signal that a human answered from the Instagram app, and
 * without them MyReply's record of a conversation ends at the last inbound
 * message. Consumers must record these and must not run automation on them.
 *
 * A deleted echo is dropped: it describes a message that no longer exists.
 * A textless echo is kept, because sending a photo is still answering.
 */
export function parseMessageEchoEvents(
  payload: WebhookPayload
): WebhookMessageEchoEvent[] {
  const events: WebhookMessageEchoEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const message = messaging.message;
      if (!message?.is_echo) continue;
      if (message.is_deleted) continue;

      const messageId = message.mid;
      const accountId = entry.id ?? messaging.sender?.id;
      const recipientId = messaging.recipient?.id;

      if (!messageId || !accountId || !recipientId) continue;
      // On an echo the account is the sender. Anything else on this entry is
      // not the account's own outbound message, so it is not ours to record.
      if (messaging.sender?.id && messaging.sender.id !== accountId) continue;
      if (recipientId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        messageId,
        messageText: message.text?.trim() ?? "",
        recipientId,
        sentAt:
          typeof messaging.timestamp === "number"
            ? new Date(messaging.timestamp)
            : undefined,
      });
    }
  }

  return events;
}

/**
 * Parse corrections to messages a user already sent.
 *
 * The `messages` event fired on the original text and matched nothing, so
 * without this a user who typos a keyword and fixes it never triggers the
 * campaign. The mid is unchanged, which is what makes re-evaluation safe: the
 * worker's `dm:<mid>` dedup key already covers the message, so a correction
 * cannot produce a second DM for one that already sent.
 */
export function parseMessageEditEvents(
  payload: WebhookPayload
): WebhookMessageEditEvent[] {
  const events: WebhookMessageEditEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const edit = messaging.message_edit;
      if (!edit) continue;

      const messageId = edit.mid;
      const text = edit.text?.trim();
      const senderId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!messageId || !text || !senderId || !accountId) continue;
      // The account correcting its own message is not a trigger, for the same
      // reason an echo is not: an autoreply must never answer itself.
      if (senderId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        messageId,
        messageText: text,
        senderId,
        numEdit: typeof edit.num_edit === "number" ? edit.num_edit : 1,
      });
    }
  }

  return events;
}

/**
 * Parse reactions placed on messages the account delivered.
 *
 * Both actions are returned. Callers decide what each one means: a "react" is a
 * positive engagement signal worth recording against the contact, an "unreact"
 * is its withdrawal and must not be recorded as one.
 */
export function parseReactionEvents(
  payload: WebhookPayload
): WebhookReactionEvent[] {
  const events: WebhookReactionEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const reaction = messaging.reaction;
      if (!reaction) continue;

      const messageId = reaction.mid;
      const userId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!messageId || !userId || !accountId) continue;
      // The account reacting to its own thread is not audience engagement.
      if (userId === accountId) continue;

      const action: ReactionAction | null =
        reaction.action === "react"
          ? "react"
          : reaction.action === "unreact"
            ? "unreact"
            : null;
      if (!action) continue;

      events.push({
        instagramAccountId: accountId,
        userId,
        messageId,
        action,
        reaction: reaction.reaction,
        emoji: reaction.emoji,
      });
    }
  }

  return events;
}

/**
 * Parse mentions of the connected account.
 *
 * Two delivery shapes are accepted, because Meta's documentation describes
 * both and an Instagram Login app may receive either:
 *
 *   1. `changes[].field === "mentions"`, the dedicated field. The value is
 *      `{ media_id }` for a caption mention and `{ comment_id, media_id }` for
 *      a comment mention.
 *   2. `changes[].field === "comments"` carrying an explicit mention marker
 *      (`item: "mention"` or `is_mention: true`), which is how Meta folds
 *      mentions into comment notifications.
 *
 * Only marked `comments` changes are read as mentions, so an ordinary comment
 * is never misread as one and nothing is processed on both paths.
 *
 * Two limits come from Meta and cannot be worked around here: mentions in
 * Stories are not delivered at all, and no webhook fires when the mentioning
 * media belongs to a private account. A missing mention is therefore expected
 * rather than a parsing failure.
 */
export function parseMentionEvents(
  payload: WebhookPayload
): WebhookMentionEvent[] {
  const events: WebhookMentionEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const isDedicatedField = change.field === "mentions";
      const isFoldedIntoComments =
        change.field === "comments" && isMentionChange(change.value);
      if (!isDedicatedField && !isFoldedIntoComments) continue;

      const value = change.value;
      const mediaId = value?.media_id ?? value?.media?.id;
      if (!entry.id || !mediaId) continue;
      // The account tagging itself is not an acquisition signal.
      if (value?.from?.id && value.from.id === entry.id) continue;

      // On the dedicated field a bare `id` is the media, so only an explicit
      // comment key counts. On the folded shape `id` follows the comments
      // convention this file already uses and is the comment.
      const commentId = isDedicatedField
        ? value?.comment_id
        : (value?.comment_id ?? value?.id);

      events.push({
        instagramAccountId: entry.id,
        mediaId,
        commentId,
        mentionerId: value?.from?.id,
        mentionerName: value?.from?.username,
        surface: commentId ? "comment" : "caption",
        deliveredOn: isDedicatedField ? "mentions" : "comments",
      });
    }
  }

  return events;
}

/**
 * Parse comments left on an Instagram Live broadcast. Structurally identical to
 * a feed comment but delivered on its own field, so it needs its own
 * subscription and its own parser.
 */
export function parseLiveCommentEvents(
  payload: WebhookPayload
): WebhookLiveCommentEvent[] {
  const events: WebhookLiveCommentEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "live_comments") continue;

      const value = change.value;
      const commentId = value?.id ?? value?.comment_id;
      const mediaId = value?.media?.id ?? value?.media_id;
      const commenterId = value?.from?.id;

      if (!entry.id || !commentId || !mediaId || !commenterId) continue;
      // The host's own comments on their own broadcast are not leads.
      if (commenterId === entry.id) continue;

      events.push({
        instagramAccountId: entry.id,
        commentId,
        commentText: value.text ?? "",
        commenterId,
        commenterName: value.from?.username,
        mediaId,
      });
    }
  }

  return events;
}

/**
 * Parse arrivals that carry a referral code: an ig.me link, a QR code, or a
 * website button. The code arrives either on its own referral object for a new
 * conversation, or nested in a postback when the user taps to begin.
 */
export function parseReferralEvents(
  payload: WebhookPayload
): WebhookReferralEvent[] {
  const events: WebhookReferralEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const ref = messaging.referral?.ref ?? messaging.postback?.referral?.ref;
      const userId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!ref || !userId || !accountId) continue;
      if (userId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        userId,
        ref,
        source: messaging.referral?.source,
      });
    }
  }

  return events;
}

/**
 * Parse Instagram DM read receipts. When a user reads an opening DM but does
 * not tap its button, the webhook route uses this to schedule the reveal after
 * a short grace period.
 */
export function parseReadEvents(payload: WebhookPayload): WebhookReadEvent[] {
  const events: WebhookReadEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      if (!messaging.read) continue;

      const userId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!userId || !accountId) continue;
      if (userId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        userId,
        watermark: messaging.read.watermark,
      });
    }
  }

  return events;
}
