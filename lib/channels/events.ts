import type { ChannelPlatform } from "./platforms";

/**
 * One inbound happening, in the same shape whichever platform it came from.
 *
 * An adapter turns its platform's verified webhook payload into a list of
 * these. Everything downstream (queueing, opt-out, contacts, echoes, the
 * inbox) reads only this shape, so a new platform plugs in by producing it.
 *
 * `accountExternalId` is the platform's own id for the connected account the
 * event was delivered to: the Instagram professional account id, a Facebook
 * Page id, and so on. It is how the engine finds the tenant, and nothing in a
 * payload can name a different one.
 */
interface EventBase {
  platform: ChannelPlatform;
  accountExternalId: string;
}

/** Someone commented. `surface` separates a feed post from a live stream. */
export interface CommentEvent extends EventBase {
  type: "comment";
  surface: "feed" | "live";
  commentId: string;
  text: string;
  authorId: string;
  authorName?: string;
  mediaId: string;
  /**
   * Set when the comment was left on a boosted copy of a post: the id of the
   * organic post it came from, which is what campaigns are bound to.
   */
  originalMediaId?: string;
  /** When the comment was made, when the platform says. */
  createdAt?: Date;
}

export type MessageKind = "dm" | "story_reply" | "story_mention";

/** Someone sent the account a message. */
export interface MessageEvent extends EventBase {
  type: "message";
  messageId: string;
  text: string;
  senderId: string;
  kind: MessageKind;
  storyId?: string;
  storyUrl?: string;
  /** Present when the message was a tap on one of our quick replies. */
  quickReplyPayload?: string;
}

/** Someone tapped a postback button we sent. */
export interface PostbackEvent extends EventBase {
  type: "postback";
  userId: string;
  payload: string;
  /** The platform's id for the tap, when it gives one. Used for dedupe. */
  mid?: string;
}

/** Someone opened a conversation through a link carrying a ref. */
export interface ReferralEvent extends EventBase {
  type: "referral";
  userId: string;
  ref: string;
  source?: string;
}

/** Someone read the conversation up to a point. */
export interface ReadEvent extends EventBase {
  type: "read";
  userId: string;
  watermark?: number;
}

/** Someone corrected a message they already sent. */
export interface MessageEditEvent extends EventBase {
  type: "message_edit";
  messageId: string;
  text: string;
  senderId: string;
  /** Which correction this is, so each one is its own job. */
  editCount: number;
}

/** A message the account itself sent, echoed back. Recorded, never acted on. */
export interface EchoEvent extends EventBase {
  type: "echo";
  messageId: string;
  text: string;
  recipientId: string;
  sentAt?: Date;
}

export type ReactionAction = "react" | "unreact";

/** Someone reacted to a message we sent. */
export interface ReactionEvent extends EventBase {
  type: "reaction";
  userId: string;
  messageId: string;
  action: ReactionAction;
  reaction?: string;
  emoji?: string;
}

export type MentionSurface = "caption" | "comment";

/** The account was mentioned somewhere. Recorded and surfaced only. */
export interface MentionEvent extends EventBase {
  type: "mention";
  mediaId: string;
  commentId?: string;
  mentionerId?: string;
  mentionerName?: string;
  surface: MentionSurface;
  /** Which of the platform's documented shapes it arrived in. */
  deliveredOn: string;
}

export type ChannelEvent =
  | CommentEvent
  | MessageEvent
  | PostbackEvent
  | ReferralEvent
  | ReadEvent
  | MessageEditEvent
  | EchoEvent
  | ReactionEvent
  | MentionEvent;

export type ChannelEventType = ChannelEvent["type"];
