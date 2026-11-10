import type { ChannelEvent } from "../events";

/**
 * Facebook Page webhook payloads, as channel events.
 *
 * Shapes from Meta's Page webhook and Messenger webhook references: comments
 * arrive on the `feed` field as `changes` with item "comment" and verb "add";
 * messages, button taps, reads, link arrivals, edits, echoes and reactions
 * arrive as `messaging` entries. Every entry is keyed by the Page id.
 *
 * The order matches the Instagram adapter's (comments, referrals, taps,
 * messages, reads, edits, echoes, reactions), so both platforms are handled
 * the same way within a batch.
 */

const platform = "FACEBOOK" as const;

interface FeedValue {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  parent_id?: string;
  message?: string;
  created_time?: number | string;
  from?: { id?: string; name?: string };
}

interface MessagingEntry {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
  };
  postback?: { mid?: string; payload?: string; title?: string };
  read?: { watermark?: number };
  referral?: { ref?: string; source?: string };
  reaction?: { mid?: string; action?: string; reaction?: string; emoji?: string };
  message_edit?: { mid?: string; text?: string; num_edit?: number };
}

interface PageEntry {
  id?: string;
  time?: number;
  changes?: Array<{ field?: string; value?: FeedValue }>;
  messaging?: MessagingEntry[];
}

export function isPagePayload(
  payload: unknown
): payload is { object: "page"; entry: PageEntry[] } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { object?: unknown }).object === "page" &&
    Array.isArray((payload as { entry?: unknown }).entry)
  );
}

/** `created_time` on a feed change is unix seconds; tolerate an ISO string. */
function feedTime(value: number | string | undefined): Date | undefined {
  if (typeof value === "number" && value > 0) return new Date(value > 1e12 ? value : value * 1000);
  if (typeof value === "string") {
    const at = new Date(value);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return undefined;
}

export function parseFacebookEvents(payload: unknown): ChannelEvent[] {
  if (!isPagePayload(payload)) return [];

  const comments: ChannelEvent[] = [];
  const referrals: ChannelEvent[] = [];
  const postbacks: ChannelEvent[] = [];
  const messages: ChannelEvent[] = [];
  const reads: ChannelEvent[] = [];
  const edits: ChannelEvent[] = [];
  const echoes: ChannelEvent[] = [];
  const reactions: ChannelEvent[] = [];

  for (const entry of payload.entry) {
    const pageId = entry.id;
    if (!pageId) continue;

    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (change.field !== "feed" || !value) continue;
      if (value.item !== "comment" || value.verb !== "add") continue;
      const authorId = value.from?.id;
      if (!value.comment_id || !value.post_id || !authorId) continue;
      // The Page's own comments and replies. A private reply to itself is
      // refused, so queueing one only produces a failed log.
      if (authorId === pageId) continue;

      comments.push({
        type: "comment",
        platform,
        surface: "feed",
        accountExternalId: pageId,
        commentId: value.comment_id,
        text: value.message ?? "",
        authorId,
        authorName: value.from?.name,
        mediaId: value.post_id,
        createdAt: feedTime(value.created_time),
      });
    }

    for (const item of entry.messaging ?? []) {
      const senderId = item.sender?.id;
      const recipientId = item.recipient?.id;

      if (item.message?.is_echo) {
        // The Page sent it; the person is the recipient.
        if (item.message.mid && recipientId) {
          echoes.push({
            type: "echo",
            platform,
            accountExternalId: pageId,
            messageId: item.message.mid,
            text: item.message.text ?? "",
            recipientId,
            sentAt: typeof item.timestamp === "number" ? new Date(item.timestamp) : undefined,
          });
        }
        continue;
      }

      if (!senderId || senderId === pageId) continue;

      if (item.referral?.ref) {
        referrals.push({
          type: "referral",
          platform,
          accountExternalId: pageId,
          userId: senderId,
          ref: item.referral.ref,
          source: item.referral.source,
        });
      }

      if (item.postback?.payload) {
        postbacks.push({
          type: "postback",
          platform,
          accountExternalId: pageId,
          userId: senderId,
          payload: item.postback.payload,
          mid: item.postback.mid,
        });
      }

      if (item.message?.mid && (item.message.text || item.message.quick_reply)) {
        messages.push({
          type: "message",
          platform,
          accountExternalId: pageId,
          messageId: item.message.mid,
          text: item.message.text ?? "",
          senderId,
          kind: "dm",
          quickReplyPayload: item.message.quick_reply?.payload,
        });
      }

      if (item.read) {
        reads.push({
          type: "read",
          platform,
          accountExternalId: pageId,
          userId: senderId,
          watermark: item.read.watermark,
        });
      }

      if (item.message_edit?.mid && typeof item.message_edit.text === "string") {
        edits.push({
          type: "message_edit",
          platform,
          accountExternalId: pageId,
          messageId: item.message_edit.mid,
          text: item.message_edit.text,
          senderId,
          editCount: item.message_edit.num_edit ?? 1,
        });
      }

      if (item.reaction?.mid && (item.reaction.action === "react" || item.reaction.action === "unreact")) {
        reactions.push({
          type: "reaction",
          platform,
          accountExternalId: pageId,
          userId: senderId,
          messageId: item.reaction.mid,
          action: item.reaction.action,
          reaction: item.reaction.reaction,
          emoji: item.reaction.emoji,
        });
      }
    }
  }

  return [
    ...comments,
    ...referrals,
    ...postbacks,
    ...messages,
    ...reads,
    ...edits,
    ...echoes,
    ...reactions,
  ];
}
