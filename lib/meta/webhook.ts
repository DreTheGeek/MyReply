import { createHmac, timingSafeEqual } from "crypto";

export function verifyWebhookSignature(
  payload: string,
  signature: string | null
): boolean {
  if (!signature) return false;

  // Instagram-Login apps sign webhooks with the Instagram app secret, while
  // Facebook-Login apps use the Facebook app secret. Both belong to the same
  // app, so accept a signature that matches either — this avoids a config
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

interface WebhookEntry {
  id: string;
  time: number;
  changes?: Array<{
    field: string;
    value: {
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
    };
  }>;
  messaging?: Array<{
    sender?: { id?: string };
    recipient?: { id?: string };
    postback?: { mid?: string; title?: string; payload?: string; referral?: { ref?: string } };
    read?: { watermark?: number; seq?: number };
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
 * the worker never sees them — an echo would otherwise let an autoreply
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
        storyId: repliedStory?.id,
        storyUrl: repliedStory?.url ?? mentionAttachment?.payload?.url,
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
