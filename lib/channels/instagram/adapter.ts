import * as meta from "@/lib/meta/client";
import {
  clearPersistentMenu,
  getPersistentMenu,
  setPersistentMenu,
} from "@/lib/meta/persistent-menu";
import {
  decryptToken,
  exchangeCodeForToken,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";
import { verifyWebhookSignature } from "@/lib/meta/webhook";
import type {
  ChannelAdapter,
  ChannelContext,
  ChannelMessaging,
} from "../adapter";
import { getChannelCapabilities } from "../capabilities";
import {
  UnsupportedContentError,
  type ChannelComment,
  type ChannelConversation,
  type ChannelMedia,
  type ChannelMediaType,
  type ChannelMessage,
  type ChannelProfile,
  type OutboundContent,
  type SendReceipt,
  type SendTarget,
} from "../content";
import { parseInstagramEvents } from "./events";

/**
 * Instagram, through the Instagram API with Instagram Login.
 *
 * A thin layer. Every call lands on the same lib/meta function, with the same
 * arguments, that the engine called before adapters existed, so moving a caller
 * behind this changes nothing Instagram receives.
 */

const PLATFORM = "INSTAGRAM" as const;

// ─── Sending ────────────────────────────────────────────────────────────────

/**
 * Pick the one Graph call that carries this content to this target.
 *
 * Instagram's button template carries either web links (up to three) or a
 * single postback, never a mix, and a file only goes to an open conversation.
 * Anything else is refused here, before a request is made, because a reshaped
 * message is a different message.
 */
async function send(
  context: ChannelContext,
  {
    to,
    content,
    humanAgent = false,
  }: { to: SendTarget; content: OutboundContent; humanAgent?: boolean }
): Promise<SendReceipt> {
  if (humanAgent && (to.kind !== "user" || content.kind !== "text" || content.quickReplies?.length)) {
    throw new UnsupportedContentError(
      "A human agent reply is plain text to an open conversation."
    );
  }
  const token = context.accessToken;
  const account = context.accountExternalId;

  if (content.kind === "attachment") {
    if (to.kind !== "user") {
      throw new UnsupportedContentError(
        "Instagram cannot send a file as a private reply to a comment."
      );
    }
    return receipt(
      await meta.sendAttachment(token, account, to.userId, content.url, content.mediaType)
    );
  }

  if (content.kind === "text") {
    const quickReplies = content.quickReplies ?? [];
    if (to.kind === "comment") {
      return receipt(
        quickReplies.length > 0
          ? await meta.sendPrivateReplyWithQuickReplies(
              token,
              account,
              to.commentId,
              content.text,
              quickReplies
            )
          : await meta.sendPrivateReply(token, account, to.commentId, content.text)
      );
    }
    return receipt(
      quickReplies.length > 0
        ? await meta.sendDirectMessageWithQuickReplies(
            token,
            account,
            to.userId,
            content.text,
            quickReplies
          )
        : humanAgent
          ? await meta.sendDirectMessage(token, account, to.userId, content.text, {
              humanAgent: true,
            })
          : await meta.sendDirectMessage(token, account, to.userId, content.text)
    );
  }

  const { buttons } = content;
  if (buttons.length === 0) {
    throw new UnsupportedContentError("A button message needs at least one button.");
  }

  const postbacks = buttons.filter((button) => button.type === "postback");
  if (postbacks.length > 0) {
    if (postbacks.length !== 1 || buttons.length !== 1) {
      throw new UnsupportedContentError(
        "Instagram carries one postback button per message, with no links beside it."
      );
    }
    const [button] = postbacks;
    return receipt(
      to.kind === "comment"
        ? await meta.sendPrivateReplyWithButton(
            token,
            account,
            to.commentId,
            content.text,
            button.title,
            button.payload
          )
        : await meta.sendDirectMessageWithButton(
            token,
            account,
            to.userId,
            content.text,
            button.title,
            button.payload
          )
    );
  }

  const links = buttons.flatMap((button) =>
    button.type === "url" ? [{ title: button.title, url: button.url }] : []
  );
  return receipt(
    to.kind === "comment"
      ? await meta.sendPrivateReplyWithLinkButton(
          token,
          account,
          to.commentId,
          content.text,
          links
        )
      : await meta.sendDirectMessageWithLinkButton(
          token,
          account,
          to.userId,
          content.text,
          links
        )
  );
}

function receipt(
  result: { message_id?: string; recipient_id?: string } | undefined
): SendReceipt {
  return {
    ...(result?.message_id ? { messageId: result.message_id } : {}),
    ...(result?.recipient_id ? { recipientId: result.recipient_id } : {}),
  };
}

const messaging: ChannelMessaging = {
  send,
  async publicReply(context, { commentId, text }) {
    return meta.sendCommentReply(context.accessToken, commentId, text);
  },
  async followStatus(context, userId) {
    return meta.getUserFollowStatus(context.accessToken, userId);
  },
  async username(context, userId) {
    return meta.getUserUsername(context.accessToken, userId);
  },
};

// ─── Reading ────────────────────────────────────────────────────────────────

function toMediaType(raw: string): ChannelMediaType {
  if (raw === "IMAGE") return "IMAGE";
  if (raw === "VIDEO") return "VIDEO";
  if (raw === "CAROUSEL_ALBUM") return "CAROUSEL";
  return "OTHER";
}

export function toChannelMedia(media: meta.InstagramMedia): ChannelMedia {
  return {
    id: media.id,
    caption: media.caption ?? null,
    mediaType: toMediaType(media.media_type),
    isReel: media.media_product_type === "REELS",
    mediaUrl: media.media_url ?? null,
    thumbnailUrl: media.thumbnail_url ?? null,
    permalink: media.permalink ?? null,
    timestamp: media.timestamp,
    likeCount: media.like_count ?? null,
    commentsCount: media.comments_count ?? null,
  };
}

function toChannelComment(comment: meta.InstagramComment): ChannelComment {
  return {
    id: comment.id,
    text: comment.text,
    authorId: comment.from?.id ?? null,
    authorName: comment.from?.username ?? null,
    timestamp: comment.timestamp,
    replyAuthorIds: (comment.replies?.data ?? []).flatMap((reply) =>
      reply.from?.id ? [reply.from.id] : []
    ),
  };
}

function toChannelProfile(user: meta.InstagramUser): ChannelProfile {
  return {
    // `user_id` is the professional account id the webhook speaks in; `id` is
    // app-scoped. Prefer the one events will carry.
    externalId: user.user_id ?? user.id,
    username: user.username,
    name: user.name ?? null,
    profilePictureUrl: user.profile_picture_url ?? null,
    followersCount:
      typeof user.followers_count === "number" ? user.followers_count : null,
  };
}

function toChannelMessage(message: meta.InstagramMessage): ChannelMessage {
  return {
    id: message.id,
    text: message.message ?? null,
    fromId: message.from?.id ?? null,
    fromUsername: message.from?.username ?? null,
    createdAt: message.created_time ?? null,
  };
}

function toChannelConversation(
  conversation: meta.InstagramConversation
): ChannelConversation {
  return {
    id: conversation.id,
    detailsUnavailable: Boolean(conversation.detailsUnavailable),
    updatedAt: conversation.updated_time ?? null,
    participants: (conversation.participants?.data ?? []).map((participant) => ({
      id: participant.id,
      username: participant.username ?? null,
    })),
    messages: (conversation.messages?.data ?? []).map(toChannelMessage),
  };
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Codes that prove Meta refused the send, so nothing went out. Code 1 is NOT
 * here: Meta returns it for outcomes it is unsure of, including ones that
 * delivered.
 */
const CONFIRMED_REJECTION_CODES = [10, 100, 200, 551];

/**
 * A code 100 that is about the recipient or the window rather than the
 * template. A text retry would fail the same way, and on a comment it would
 * fail as "already replied", hiding the real reason.
 */
const NON_TEMPLATE_REJECTIONS = [
  /outside of allowed window/i,
  /invalid for a private reply/i,
  /requested user cannot be found/i,
];

// ─── The adapter ────────────────────────────────────────────────────────────

export const instagramAdapter: ChannelAdapter = {
  platform: PLATFORM,
  capabilities: getChannelCapabilities(PLATFORM),

  hasCredentials(account) {
    return Boolean(account.accessToken);
  },

  async openContext(account) {
    return {
      platform: PLATFORM,
      accountExternalId: account.instagramId,
      accessToken: decryptToken(account.accessToken),
    };
  },

  auth: {
    authorizationUrl({ redirectUri, state }) {
      return getAuthorizationUrl(redirectUri, state);
    },
    async completeConnection({ code, redirectUri }) {
      const { accessToken: shortLived } = await exchangeCodeForToken(
        code,
        redirectUri
      );
      const { accessToken, expiresIn } = await meta.getLongLivedToken(shortLived);
      const profile = toChannelProfile(await meta.getUserInfo(accessToken));
      return {
        externalId: profile.externalId,
        username: profile.username,
        name: profile.name,
        accessToken,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      };
    },
    async refreshToken(context) {
      const { accessToken, expiresIn } = await meta.refreshLongLivedToken(
        context.accessToken
      );
      return { accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000) };
    },
    async subscribeToEvents(context) {
      const result = await meta.subscribeInstagramAccountToWebhooks(
        context.accountExternalId,
        context.accessToken
      );
      return Boolean(result.success);
    },
  },

  webhook: {
    endpoint: "meta",
    accepts(payload) {
      return (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { object?: unknown }).object === "instagram"
      );
    },
    verifyChallenge(params) {
      const expected = process.env.WEBHOOK_VERIFY_TOKEN;
      if (
        params.get("hub.mode") === "subscribe" &&
        expected &&
        params.get("hub.verify_token") === expected
      ) {
        return params.get("hub.challenge") ?? "";
      }
      return null;
    },
    verifySignature(rawBody, headers) {
      return verifyWebhookSignature(rawBody, headers.get("x-hub-signature-256"));
    },
    parse(payload) {
      return parseInstagramEvents(payload);
    },
    scopePayload(payload, accountExternalIds) {
      if (typeof payload !== "object" || payload === null) return payload;
      const entry = (payload as { entry?: unknown }).entry;
      if (!Array.isArray(entry)) return payload;
      // Instagram files each account's events under its own entry, keyed by
      // the account id, so scoping is keeping the right entries.
      return {
        ...payload,
        entry: entry.filter(
          (item: unknown) =>
            typeof item === "object" &&
            item !== null &&
            accountExternalIds.has(String((item as { id?: unknown }).id))
        ),
      };
    },
  },

  messaging,

  content: {
    async profile(context) {
      return toChannelProfile(await meta.getUserInfo(context.accessToken));
    },
    async recentMedia(context, { limit }) {
      return (await meta.getUserMedia(context.accessToken, limit)).map(toChannelMedia);
    },
    async allMedia(context, { max }) {
      return (await meta.getAllUserMedia(context.accessToken, max)).map(toChannelMedia);
    },
    async recentComments(context, { mediaId, sinceMs, max = 800 }) {
      return (
        await meta.getRecentMediaComments(context.accessToken, mediaId, sinceMs, max)
      ).map(toChannelComment);
    },
    async mediaInsights(context, { mediaId, metrics }) {
      const insights = await meta.getMediaInsights(context.accessToken, mediaId, metrics);
      return {
        views: insights.views,
        reach: insights.reach,
        likes: insights.likes,
        comments: insights.comments,
        saved: insights.saved,
        shares: insights.shares,
        totalInteractions: insights.total_interactions,
      };
    },
    async followerHistory(context) {
      return meta.getFollowerCountSeries(
        context.accessToken,
        context.accountExternalId
      );
    },
  },

  inbox: {
    async conversations(context) {
      return (
        await meta.getConversations(context.accessToken, context.accountExternalId)
      ).map(toChannelConversation);
    },
    async messages(context, conversationId) {
      return (
        await meta.getConversationMessages(context.accessToken, conversationId)
      ).map(toChannelMessage);
    },
  },

  profileSettings: {
    async iceBreakers(context) {
      return meta.getConversationStarters(
        context.accessToken,
        context.accountExternalId
      );
    },
    async setIceBreakers(context, items) {
      await meta.setConversationStarters(
        context.accessToken,
        context.accountExternalId,
        items
      );
    },
    async clearIceBreakers(context) {
      await meta.clearConversationStarters(
        context.accessToken,
        context.accountExternalId
      );
    },
    async persistentMenu(context) {
      return getPersistentMenu(context.accessToken, context.accountExternalId);
    },
    async setPersistentMenu(context, items) {
      await setPersistentMenu(context.accessToken, context.accountExternalId, items);
    },
    async clearPersistentMenu(context) {
      await clearPersistentMenu(context.accessToken, context.accountExternalId);
    },
  },

  errors: {
    isConfirmedRejection(error) {
      if (error instanceof meta.RateLimitError || error instanceof meta.TokenExpiredError) {
        return true;
      }
      return (
        error instanceof meta.MetaApiError &&
        CONFIRMED_REJECTION_CODES.includes(error.code)
      );
    },
    isRichContentRejection(error) {
      if (error instanceof meta.TokenExpiredError || error instanceof meta.RateLimitError) {
        return false;
      }
      // Falling back is another send: allow it only for a proven template error.
      return (
        error instanceof meta.MetaApiError &&
        error.code === 100 &&
        /template|button/i.test(error.message) &&
        !NON_TEMPLATE_REJECTIONS.some((pattern) => pattern.test(error.message))
      );
    },
    isPermissionDenied(error) {
      return error instanceof meta.PermissionError;
    },
    userMessage(error) {
      return error instanceof meta.MetaApiError ? error.message : null;
    },
    isLegacyUnconfirmed(errorMessage) {
      return Boolean(
        errorMessage &&
          /(?:MetaApiError (?:1|2|5\d\d):|\[code=(?:1|2|5\d\d)\b)/.test(errorMessage)
      );
    },
  },
};
