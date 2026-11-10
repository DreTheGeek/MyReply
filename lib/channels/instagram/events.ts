import {
  parseCommentEvents,
  parseLiveCommentEvents,
  parseMentionEvents,
  parseMessageEchoEvents,
  parseMessageEditEvents,
  parseMessageEvents,
  parsePostbackEvents,
  parseReactionEvents,
  parseReadEvents,
  parseReferralEvents,
} from "@/lib/meta/webhook";
import type { ChannelEvent } from "../events";

const platform = "INSTAGRAM" as const;

type InstagramPayload = Parameters<typeof parseCommentEvents>[0];

function isInstagramPayload(payload: unknown): payload is InstagramPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { object?: unknown }).object === "instagram" &&
    Array.isArray((payload as { entry?: unknown }).entry)
  );
}

/**
 * Every event in one Instagram webhook payload, as channel events.
 *
 * The order is the order the webhook has always handled them in: comments,
 * live comments, referrals, button taps, messages, read receipts, edits,
 * echoes, reactions, mentions. Kept deliberately, because an opt-out in a
 * message and a tap in the same batch must resolve the way they always have.
 *
 * The per-field parsing rules live in lib/meta/webhook.ts and are tested
 * there; this only renames fields into the shared shape.
 */
export function parseInstagramEvents(payload: unknown): ChannelEvent[] {
  if (!isInstagramPayload(payload)) return [];

  const events: ChannelEvent[] = [];

  for (const e of parseCommentEvents(payload)) {
    events.push({
      type: "comment",
      platform,
      surface: "feed",
      accountExternalId: e.instagramAccountId,
      commentId: e.commentId,
      text: e.commentText,
      authorId: e.commenterId,
      authorName: e.commenterName,
      mediaId: e.mediaId,
      originalMediaId: e.originalMediaId,
      createdAt: e.createdAt,
    });
  }

  for (const e of parseLiveCommentEvents(payload)) {
    events.push({
      type: "comment",
      platform,
      surface: "live",
      accountExternalId: e.instagramAccountId,
      commentId: e.commentId,
      text: e.commentText,
      authorId: e.commenterId,
      authorName: e.commenterName,
      mediaId: e.mediaId,
    });
  }

  for (const e of parseReferralEvents(payload)) {
    events.push({
      type: "referral",
      platform,
      accountExternalId: e.instagramAccountId,
      userId: e.userId,
      ref: e.ref,
      source: e.source,
    });
  }

  for (const e of parsePostbackEvents(payload)) {
    events.push({
      type: "postback",
      platform,
      accountExternalId: e.instagramAccountId,
      userId: e.userId,
      payload: e.payload,
      mid: e.mid,
    });
  }

  for (const e of parseMessageEvents(payload)) {
    events.push({
      type: "message",
      platform,
      accountExternalId: e.instagramAccountId,
      messageId: e.messageId,
      text: e.messageText,
      senderId: e.senderId,
      kind: e.kind,
      storyId: e.storyId,
      storyUrl: e.storyUrl,
      quickReplyPayload: e.quickReplyPayload,
    });
  }

  for (const e of parseReadEvents(payload)) {
    events.push({
      type: "read",
      platform,
      accountExternalId: e.instagramAccountId,
      userId: e.userId,
      watermark: e.watermark,
    });
  }

  for (const e of parseMessageEditEvents(payload)) {
    events.push({
      type: "message_edit",
      platform,
      accountExternalId: e.instagramAccountId,
      messageId: e.messageId,
      text: e.messageText,
      senderId: e.senderId,
      editCount: e.numEdit,
    });
  }

  for (const e of parseMessageEchoEvents(payload)) {
    events.push({
      type: "echo",
      platform,
      accountExternalId: e.instagramAccountId,
      messageId: e.messageId,
      text: e.messageText,
      recipientId: e.recipientId,
      sentAt: e.sentAt,
    });
  }

  for (const e of parseReactionEvents(payload)) {
    events.push({
      type: "reaction",
      platform,
      accountExternalId: e.instagramAccountId,
      userId: e.userId,
      messageId: e.messageId,
      action: e.action,
      reaction: e.reaction,
      emoji: e.emoji,
    });
  }

  for (const e of parseMentionEvents(payload)) {
    events.push({
      type: "mention",
      platform,
      accountExternalId: e.instagramAccountId,
      mediaId: e.mediaId,
      commentId: e.commentId,
      mentionerId: e.mentionerId,
      mentionerName: e.mentionerName,
      surface: e.surface,
      deliveredOn: e.deliveredOn,
    });
  }

  return events;
}
