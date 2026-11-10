import * as fb from "@/lib/meta/facebook";
import { decryptToken } from "@/lib/meta/oauth";
import { verifyWebhookSignature } from "@/lib/meta/webhook";
import { parseSignedRequest } from "@/lib/meta/signed-request";
import { MetaApiError, PermissionError, RateLimitError, TokenExpiredError } from "@/lib/meta/client";
import type { ChannelAdapter, ChannelContext } from "../adapter";
import { getChannelCapabilities } from "../capabilities";
import {
  UnsupportedContentError,
  type ChannelMedia,
  type ChannelMediaType,
  type OutboundContent,
  type SendReceipt,
  type SendTarget,
} from "../content";
import { parseFacebookEvents } from "./events";

/**
 * A Facebook Page, through the Messenger Platform and the Pages API.
 *
 * The connected-account row holds the Page id and a Page access token. Page
 * tokens derived from a long-lived user token do not expire, so a Page has no
 * expiry date and the token refresh cron leaves it alone.
 */

const PLATFORM = "FACEBOOK" as const;

/** Same codes as Instagram: the Graph API reports refusals identically. */
const CONFIRMED_REJECTION_CODES = [10, 100, 200, 551];

const NON_TEMPLATE_REJECTIONS = [
  /outside of allowed window/i,
  /invalid for a private reply/i,
  /cannot be found/i,
];

function recipientFor(to: SendTarget): fb.PageRecipient {
  return to.kind === "comment" ? { comment_id: to.commentId } : { id: to.userId };
}

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

  let message: fb.PageMessage;
  if (content.kind === "text") {
    message = { kind: "text", text: content.text, quickReplies: content.quickReplies };
  } else if (content.kind === "attachment") {
    if (to.kind !== "user") {
      throw new UnsupportedContentError(
        "Facebook cannot send a file as a private reply to a comment."
      );
    }
    message = { kind: "attachment", url: content.url, type: content.mediaType };
  } else {
    const { buttons } = content;
    if (buttons.length === 0) {
      throw new UnsupportedContentError("A button message needs at least one button.");
    }
    const postbacks = buttons.filter((button) => button.type === "postback");
    if (postbacks.length > 0) {
      if (postbacks.length !== 1 || buttons.length !== 1) {
        throw new UnsupportedContentError(
          "This engine sends one postback button per message, with no links beside it."
        );
      }
      const [button] = postbacks;
      message = {
        kind: "postback_button",
        text: content.text,
        title: button.title,
        payload: button.payload,
      };
    } else {
      message = {
        kind: "link_buttons",
        text: content.text,
        buttons: buttons.flatMap((button) =>
          button.type === "url" ? [{ title: button.title, url: button.url }] : []
        ),
      };
    }
  }

  const result = await fb.sendPageMessage(
    context.accessToken,
    context.accountExternalId,
    recipientFor(to),
    message,
    { humanAgent }
  );
  return {
    ...(result.message_id ? { messageId: result.message_id } : {}),
    ...(result.recipient_id ? { recipientId: result.recipient_id } : {}),
  };
}

function toMediaType(post: fb.PagePost): ChannelMediaType {
  const type = post.attachments?.data?.[0]?.media_type ?? post.attachments?.data?.[0]?.type;
  if (type === "photo") return "IMAGE";
  if (type === "video" || type === "video_inline" || type === "video_autoplay") return "VIDEO";
  if (type === "album") return "CAROUSEL";
  return "OTHER";
}

function toChannelMedia(post: fb.PagePost): ChannelMedia {
  return {
    id: post.id,
    caption: post.message ?? null,
    mediaType: toMediaType(post),
    // Facebook reels are a separate product with their own API; a Page post
    // is never treated as one.
    isReel: false,
    mediaUrl: post.full_picture ?? null,
    thumbnailUrl: post.full_picture ?? null,
    permalink: post.permalink_url ?? null,
    timestamp: post.created_time,
    likeCount: post.reactions?.summary?.total_count ?? null,
    commentsCount: post.comments?.summary?.total_count ?? null,
  };
}

export const facebookAdapter: ChannelAdapter = {
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
      return fb.getFacebookAuthorizationUrl(redirectUri, state);
    },
    async completeConnection({ code, redirectUri }) {
      const userToken = await fb.exchangeFacebookCode(code, redirectUri);
      const [pages, authorizedBy] = await Promise.all([
        fb.listManagedPages(userToken),
        fb.getFacebookUserId(userToken),
      ]);
      return pages
        // A Page the person cannot message as is no use to connect.
        .filter((page) => !page.tasks || page.tasks.includes("MESSAGING") || page.tasks.includes("MODERATE"))
        .map((page) => ({
          externalId: page.id,
          username: page.name,
          name: page.name,
          accessToken: page.access_token,
          expiresAt: null,
          authorizedByExternalId: authorizedBy,
        }));
    },
    async refreshToken(context) {
      // Page tokens from a long-lived user token do not expire.
      return { accessToken: context.accessToken, expiresAt: null };
    },
    async subscribeToEvents(context) {
      return fb.subscribePageToWebhooks(context.accountExternalId, context.accessToken);
    },
  },

  webhook: {
    endpoint: "meta",
    accepts(payload) {
      return (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { object?: unknown }).object === "page"
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
      return parseFacebookEvents(payload);
    },
    scopePayload(payload, accountExternalIds) {
      if (typeof payload !== "object" || payload === null) return payload;
      const entry = (payload as { entry?: unknown }).entry;
      if (!Array.isArray(entry)) return payload;
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

  messaging: {
    send,
    async publicReply(context, { commentId, text }) {
      return fb.replyToPageComment(context.accessToken, commentId, text);
    },
    async followStatus() {
      // Pages offer no follow check. capabilities.followGate is false, so the
      // engine never asks; this answers "unknown" if something does.
      return null;
    },
    async username(context, userId) {
      return fb.getPageScopedName(context.accessToken, userId);
    },
  },

  moderation: {
    async hideComment(context, commentId, hidden) {
      await fb.setPageCommentHidden(context.accessToken, commentId, hidden);
    },
  },

  compliance: {
    verifyCallback(body) {
      const parsed = parseSignedRequest(body.get("signed_request"), process.env.FACEBOOK_APP_SECRET);
      return parsed ? { userId: parsed.userId } : null;
    },
  },

  content: {
    async profile(context) {
      const page = await fb.getPageProfile(context.accessToken, context.accountExternalId);
      const followers = page.followers_count ?? page.fan_count;
      return {
        externalId: page.id,
        username: page.username ?? page.name,
        name: page.name,
        profilePictureUrl: page.picture?.data?.url ?? null,
        followersCount: typeof followers === "number" ? followers : null,
      };
    },
    async recentMedia(context, { limit }) {
      return (
        await fb.getPagePosts(context.accessToken, context.accountExternalId, limit)
      ).map(toChannelMedia);
    },
    async allMedia(context, { max }) {
      return (
        await fb.getAllPagePosts(context.accessToken, context.accountExternalId, max)
      ).map(toChannelMedia);
    },
    async recentComments(context, { mediaId, sinceMs, max = 100 }) {
      const comments = await fb.getRecentPostComments(context.accessToken, mediaId, sinceMs, max);
      return comments.map((comment) => ({
        id: comment.id,
        text: comment.message ?? "",
        authorId: comment.from?.id ?? null,
        authorName: comment.from?.name ?? null,
        timestamp: comment.created_time,
        replyAuthorIds: (comment.comments?.data ?? []).flatMap((reply) =>
          reply.from?.id ? [reply.from.id] : []
        ),
      }));
    },
    async mediaInsights() {
      // Page post insights need their own permission (read_insights) that
      // this engine does not request. Reactions and comment totals already
      // come back with each post.
      return {};
    },
    async followerHistory() {
      return null;
    },
  },

  inbox: {
    async conversations(context) {
      const conversations = await fb.getPageConversations(
        context.accessToken,
        context.accountExternalId
      );
      return conversations.map((conversation) => ({
        id: conversation.id,
        detailsUnavailable: false,
        updatedAt: conversation.updated_time ?? null,
        participants: (conversation.participants?.data ?? []).map((participant) => ({
          id: participant.id,
          username: participant.name ?? null,
        })),
        messages: (conversation.messages?.data ?? []).map((message) => ({
          id: message.id,
          text: message.message ?? null,
          fromId: message.from?.id ?? null,
          fromUsername: message.from?.name ?? null,
          createdAt: message.created_time ?? null,
        })),
      }));
    },
    async messages(context, conversationId) {
      const messages = await fb.getPageConversationMessages(context.accessToken, conversationId);
      return messages.map((message) => ({
        id: message.id,
        text: message.message ?? null,
        fromId: message.from?.id ?? null,
        fromUsername: message.from?.name ?? null,
        createdAt: message.created_time ?? null,
      }));
    },
  },

  profileSettings: {
    async iceBreakers(context) {
      return fb.getPageIceBreakers(context.accessToken);
    },
    async setIceBreakers(context, items) {
      await fb.setPageIceBreakers(context.accessToken, items);
    },
    async clearIceBreakers(context) {
      await fb.clearPageProfileField(context.accessToken, "ice_breakers");
    },
    async persistentMenu(context) {
      return fb.getPagePersistentMenu(context.accessToken);
    },
    async setPersistentMenu(context, items) {
      await fb.setPagePersistentMenu(context.accessToken, items);
    },
    async clearPersistentMenu(context) {
      await fb.clearPageProfileField(context.accessToken, "persistent_menu");
    },
  },

  errors: {
    isConfirmedRejection(error) {
      if (error instanceof RateLimitError || error instanceof TokenExpiredError) return true;
      return error instanceof MetaApiError && CONFIRMED_REJECTION_CODES.includes(error.code);
    },
    isRichContentRejection(error) {
      if (error instanceof TokenExpiredError || error instanceof RateLimitError) return false;
      return (
        error instanceof MetaApiError &&
        error.code === 100 &&
        /template|button/i.test(error.message) &&
        !NON_TEMPLATE_REJECTIONS.some((pattern) => pattern.test(error.message))
      );
    },
    isLegacyUnconfirmed(errorMessage) {
      return Boolean(
        errorMessage &&
          /(?:MetaApiError (?:1|2|5\d\d):|\[code=(?:1|2|5\d\d)\b)/.test(errorMessage)
      );
    },
    userMessage(error) {
      return error instanceof MetaApiError ? error.message : null;
    },
    isPermissionDenied(error) {
      return error instanceof PermissionError;
    },
  },
};
