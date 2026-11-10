import type { ChannelPlatform } from "./platforms";

/**
 * What a platform lets the engine do, declared once per platform.
 *
 * Everything that decides whether a feature exists reads this: the worker
 * before it sends, and the dashboard before it offers a toggle. A platform
 * that cannot do something never shows the switch for it, so nobody can build
 * a campaign that will only fail at send time.
 *
 * Client safe. No server imports.
 */
export interface ChannelCapabilities {
  /** Message a person who has written to the account. */
  directMessage: boolean;
  /** Message a commenter privately, from their comment. */
  privateReply: boolean;
  /** Reply under a comment, in public. */
  publicReply: boolean;
  /** Hide a comment from everyone but its author. */
  hideComment: boolean;

  /** What can start a campaign. */
  triggers: {
    comment: boolean;
    liveComment: boolean;
    dmKeyword: boolean;
    storyReply: boolean;
    storyMention: boolean;
    referral: boolean;
    /** Answering any DM no other campaign matched. */
    defaultReply: boolean;
  };

  buttons: {
    /** A button that sends a payload back to us when tapped. */
    postback: boolean;
    /** A button that opens a URL. */
    url: boolean;
    /** Most buttons one message may carry. */
    max: number;
    /** Longest button title, in characters. */
    titleMax: number;
  };

  quickReplies: {
    supported: boolean;
    max: number;
    titleMax: number;
    /** A one-tap reply prefilled with the person's own email or phone. */
    collectsEmail: boolean;
    collectsPhone: boolean;
  };

  /** Files that can be sent by public URL. */
  media: { image: boolean; video: boolean; audio: boolean; file: boolean };

  /** Can the engine ask whether a person follows the account. */
  followGate: boolean;
  /** Suggested first questions shown on a new conversation. */
  iceBreakers: {
    supported: boolean;
    max: number;
    questionMax: number;
    payloadMax: number;
  };
  /** An always-visible menu in the conversation. */
  persistentMenu: {
    supported: boolean;
    maxItems: number;
    titleMax: number;
    payloadMax: number;
  };
  /** Conversations can be listed and read through the API. */
  inbox: boolean;

  /**
   * When a message may be sent. Null means the platform sets no such limit.
   *
   * standardHours: how long after a person's last message the account may
   * write to them freely.
   * privateReplyDays: how long after a comment its private reply may go out.
   * humanAgentDays: the longer window a human (never an automation) may use
   * where the platform allows a human-agent tag.
   */
  window: {
    standardHours: number | null;
    privateReplyDays: number | null;
    humanAgentDays: number | null;
  };

  rateLimits: {
    /** Platform-documented cap on private replies per account per hour. */
    privateRepliesPerHour: number | null;
  };
}

/**
 * Instagram, through the Instagram API with Instagram Login.
 *
 * Window: 24 hours after the person's last message; a comment opens 7 days
 * for its one private reply. Cap: 750 private replies per account per hour,
 * Meta's documented limit for that call.
 *
 * Human agent: Meta's Instagram messaging docs describe "a separate 7-day
 * Human Agent window" for a human replying from a custom inbox. It needs the
 * Human Agent feature through App Review, so the engine uses it only for a
 * person replying in the inbox, and only once META_HUMAN_AGENT_APPROVED is set
 * (see lib/channels/windows.ts). Automations never use it.
 */
const INSTAGRAM: ChannelCapabilities = {
  directMessage: true,
  privateReply: true,
  publicReply: true,
  hideComment: false,
  triggers: {
    comment: true,
    liveComment: true,
    dmKeyword: true,
    storyReply: true,
    storyMention: true,
    referral: true,
    defaultReply: true,
  },
  buttons: { postback: true, url: true, max: 3, titleMax: 20 },
  quickReplies: {
    supported: true,
    max: 13,
    titleMax: 20,
    collectsEmail: true,
    collectsPhone: true,
  },
  media: { image: true, video: true, audio: true, file: true },
  followGate: true,
  iceBreakers: { supported: true, max: 4, questionMax: 80, payloadMax: 1000 },
  persistentMenu: { supported: true, maxItems: 5, titleMax: 30, payloadMax: 1000 },
  inbox: true,
  window: { standardHours: 24, privateReplyDays: 7, humanAgentDays: 7 },
  rateLimits: { privateRepliesPerHour: 750 },
};

export const CHANNEL_CAPABILITIES: Record<ChannelPlatform, ChannelCapabilities> = {
  INSTAGRAM,
};

export function getChannelCapabilities(
  platform: ChannelPlatform
): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[platform];
}

/**
 * The campaign builder's toggles, each paired with whether the platform
 * supports it. One place maps features to capabilities, so the builder, the
 * campaign page and the API all agree on what an account can do.
 */
export interface CampaignFeatureSupport {
  commentTrigger: boolean;
  liveCommentTrigger: boolean;
  dmKeywordTrigger: boolean;
  storyReplyTrigger: boolean;
  storyMentionTrigger: boolean;
  referralTrigger: boolean;
  defaultReply: boolean;
  publicReply: boolean;
  openingDm: boolean;
  linkButtons: boolean;
  quickReplies: boolean;
  attachment: boolean;
  followGate: boolean;
}

export function campaignFeatureSupport(
  capabilities: ChannelCapabilities
): CampaignFeatureSupport {
  const { triggers, buttons, quickReplies, media } = capabilities;
  return {
    commentTrigger: triggers.comment && capabilities.privateReply,
    liveCommentTrigger: triggers.liveComment && capabilities.privateReply,
    dmKeywordTrigger: triggers.dmKeyword && capabilities.directMessage,
    storyReplyTrigger: triggers.storyReply && capabilities.directMessage,
    storyMentionTrigger: triggers.storyMention && capabilities.directMessage,
    referralTrigger: triggers.referral && capabilities.directMessage,
    defaultReply: triggers.defaultReply && capabilities.directMessage,
    publicReply: capabilities.publicReply,
    // The opening DM is a message with one postback button.
    openingDm: buttons.postback,
    linkButtons: buttons.url,
    quickReplies: quickReplies.supported,
    attachment: media.image || media.video || media.audio || media.file,
    // The gate needs both the follow check and a button to re-check on.
    followGate: capabilities.followGate && buttons.postback,
  };
}
