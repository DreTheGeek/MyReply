/**
 * What the engine sends and reads, in platform-neutral terms.
 *
 * Callers describe the message they want (text, buttons, quick replies, a
 * file) and who it is for. The adapter decides which platform call carries
 * it. A combination the platform cannot carry is refused with
 * UnsupportedContentError before anything is sent, never silently reshaped.
 */

export type ButtonSpec =
  | { type: "url"; title: string; url: string }
  | { type: "postback"; title: string; payload: string };

export type QuickReplyKind = "text" | "email" | "phone";

/** Same shape a campaign stores, so stored quick replies pass straight in. */
export interface QuickReplySpec {
  title: string;
  type: QuickReplyKind;
  payload?: string | null;
}

export type AttachmentKind = "image" | "video" | "audio" | "file";

/** What kind of file a public URL points at, from its extension. */
export function inferAttachmentKind(url: string): AttachmentKind {
  const path = url.split("?")[0].split("#")[0].toLowerCase();
  if (/\.(jpe?g|png|gif|webp)$/.test(path)) return "image";
  if (/\.(mp4|mov|webm)$/.test(path)) return "video";
  if (/\.(mp3|m4a|wav|ogg)$/.test(path)) return "audio";
  return "file";
}

export type OutboundContent =
  | { kind: "text"; text: string; quickReplies?: QuickReplySpec[] }
  | { kind: "buttons"; text: string; buttons: ButtonSpec[] }
  | { kind: "attachment"; url: string; mediaType: AttachmentKind };

/**
 * Who a message is for.
 *
 * "comment" is a private reply: a message to the comment's author, opened by
 * the comment itself. "user" is an ordinary message inside an open
 * conversation.
 */
export type SendTarget =
  | { kind: "comment"; commentId: string; postId?: string }
  | { kind: "user"; userId: string };

export interface SendReceipt {
  messageId?: string;
  recipientId?: string;
}

/** The content cannot be carried by this platform or this target. */
export class UnsupportedContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedContentError";
  }
}

/** A connected account as the platform describes it. */
export interface ChannelProfile {
  externalId: string;
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
  followersCount: number | null;
}

export type ChannelMediaType = "IMAGE" | "VIDEO" | "CAROUSEL" | "OTHER";

/** One post, reel or video on the connected account. */
export interface ChannelMedia {
  id: string;
  caption: string | null;
  mediaType: ChannelMediaType;
  /** True for short-form video posted as a reel (or the platform's equivalent). */
  isReel: boolean;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  /** ISO 8601. */
  timestamp: string;
  likeCount: number | null;
  commentsCount: number | null;
}

/** Per-post numbers. Absent means the platform did not report it. */
export interface ChannelMediaInsights {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  saved?: number;
  shares?: number;
  totalInteractions?: number;
}

/** One day's change in followers, as the platform reports it. */
export interface FollowerDelta {
  /** ISO date. */
  date: string;
  delta: number;
}

/** A comment as read back from the platform, for the reconciler. */
export interface ChannelComment {
  id: string;
  text: string;
  authorId: string | null;
  authorName: string | null;
  /** ISO 8601. */
  timestamp: string;
  /** Who has replied under it, so an owner's answer can be detected. */
  replyAuthorIds: string[];
}

export interface ChannelParticipant {
  id: string;
  username: string | null;
}

export interface ChannelMessage {
  id: string;
  text: string | null;
  fromId: string | null;
  fromUsername: string | null;
  /** ISO 8601. */
  createdAt: string | null;
}

export interface ChannelConversation {
  id: string;
  /** True when the platform listed the thread but its details failed to load. */
  detailsUnavailable: boolean;
  /** ISO 8601. */
  updatedAt: string | null;
  participants: ChannelParticipant[];
  /** Newest first, as many as the platform returned with the list. */
  messages: ChannelMessage[];
}

/** A suggested first question on a new conversation. */
export interface IceBreaker {
  question: string;
  payload: string;
}

/** One item in a conversation's always-visible menu. */
export type MenuItem =
  | { type: "postback"; title: string; payload: string }
  | { type: "web_url"; title: string; url: string };
