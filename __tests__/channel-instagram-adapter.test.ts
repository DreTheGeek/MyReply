/**
 * The Instagram channel adapter.
 *
 * The adapter's promise is that it changes nothing Instagram receives: each
 * neutral send lands on exactly the lib/meta call the engine made before
 * adapters, with the same arguments. These tests pin that mapping, the
 * combinations it refuses, the event shape it produces, and its error rules.
 */

import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  sendPrivateReply: vi.fn(),
  sendPrivateReplyWithQuickReplies: vi.fn(),
  sendPrivateReplyWithButton: vi.fn(),
  sendPrivateReplyWithLinkButton: vi.fn(),
  sendDirectMessage: vi.fn(),
  sendDirectMessageWithQuickReplies: vi.fn(),
  sendDirectMessageWithButton: vi.fn(),
  sendDirectMessageWithLinkButton: vi.fn(),
  sendAttachment: vi.fn(),
  sendCommentReply: vi.fn(),
}));

vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/meta/client")>()),
  ...m,
}));
vi.mock("@/lib/meta/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/meta/oauth")>()),
  decryptToken: (value: string) => `plain:${value}`,
}));

import { MetaApiError, RateLimitError, TokenExpiredError } from "../lib/meta/client";
import type { ChannelContext } from "../lib/channels/adapter";
import {
  campaignFeatureSupport,
  getChannelCapabilities,
  type ChannelCapabilities,
} from "../lib/channels/capabilities";
import { UnsupportedContentError } from "../lib/channels/content";
import { classifySendError, isDeliveryUnconfirmed } from "../lib/channels/errors";
import { instagramAdapter } from "../lib/channels/instagram/adapter";
import { CHANNEL_PLATFORMS } from "../lib/channels/platforms";
import {
  adapterForWebhookPayload,
  getChannelAdapter,
  openChannel,
} from "../lib/channels/registry";

const ctx: ChannelContext = {
  platform: "INSTAGRAM",
  accountExternalId: "ig_1",
  accessToken: "tok",
};
const send = instagramAdapter.messaging.send;

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(m)) {
    fn.mockResolvedValue({ recipient_id: "user_1", message_id: "mid_1" });
  }
});

describe("send: one neutral message, one Graph call", () => {
  it("plain text to a comment is a private reply", async () => {
    const receipt = await send(ctx, {
      to: { kind: "comment", commentId: "c1" },
      content: { kind: "text", text: "hi" },
    });
    expect(m.sendPrivateReply).toHaveBeenCalledWith("tok", "ig_1", "c1", "hi");
    expect(receipt).toEqual({ messageId: "mid_1", recipientId: "user_1" });
  });

  it("text with quick replies to a comment carries them", async () => {
    const quickReplies = [{ title: "Email me", type: "email" as const }];
    await send(ctx, {
      to: { kind: "comment", commentId: "c1" },
      content: { kind: "text", text: "hi", quickReplies },
    });
    expect(m.sendPrivateReplyWithQuickReplies).toHaveBeenCalledWith(
      "tok", "ig_1", "c1", "hi", quickReplies
    );
    expect(m.sendPrivateReply).not.toHaveBeenCalled();
  });

  it("an empty quick reply list sends plain text", async () => {
    await send(ctx, {
      to: { kind: "user", userId: "u1" },
      content: { kind: "text", text: "hi", quickReplies: [] },
    });
    expect(m.sendDirectMessage).toHaveBeenCalledWith("tok", "ig_1", "u1", "hi");
    expect(m.sendDirectMessageWithQuickReplies).not.toHaveBeenCalled();
  });

  it("text with quick replies to a person carries them", async () => {
    const quickReplies = [{ title: "Yes", type: "text" as const, payload: "reveal:a1" }];
    await send(ctx, {
      to: { kind: "user", userId: "u1" },
      content: { kind: "text", text: "hi", quickReplies },
    });
    expect(m.sendDirectMessageWithQuickReplies).toHaveBeenCalledWith(
      "tok", "ig_1", "u1", "hi", quickReplies
    );
  });

  it("one postback button on a comment is the opening-DM call", async () => {
    await send(ctx, {
      to: { kind: "comment", commentId: "c1" },
      content: {
        kind: "buttons",
        text: "tap",
        buttons: [{ type: "postback", title: "Send it", payload: "reveal:a1" }],
      },
    });
    expect(m.sendPrivateReplyWithButton).toHaveBeenCalledWith(
      "tok", "ig_1", "c1", "tap", "Send it", "reveal:a1"
    );
  });

  it("one postback button to a person is the DM button call", async () => {
    await send(ctx, {
      to: { kind: "user", userId: "u1" },
      content: {
        kind: "buttons",
        text: "tap",
        buttons: [{ type: "postback", title: "Done", payload: "followcheck:a1" }],
      },
    });
    expect(m.sendDirectMessageWithButton).toHaveBeenCalledWith(
      "tok", "ig_1", "u1", "tap", "Done", "followcheck:a1"
    );
  });

  it("link buttons go out as one link template, in order", async () => {
    await send(ctx, {
      to: { kind: "comment", commentId: "c1" },
      content: {
        kind: "buttons",
        text: "links",
        buttons: [
          { type: "url", title: "One", url: "https://a.test" },
          { type: "url", title: "Two", url: "https://b.test" },
        ],
      },
    });
    expect(m.sendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "tok", "ig_1", "c1", "links",
      [{ title: "One", url: "https://a.test" }, { title: "Two", url: "https://b.test" }]
    );

    await send(ctx, {
      to: { kind: "user", userId: "u1" },
      content: { kind: "buttons", text: "links", buttons: [{ type: "url", title: "One", url: "https://a.test" }] },
    });
    expect(m.sendDirectMessageWithLinkButton).toHaveBeenCalledWith(
      "tok", "ig_1", "u1", "links", [{ title: "One", url: "https://a.test" }]
    );
  });

  it("a file goes to an open conversation", async () => {
    await send(ctx, {
      to: { kind: "user", userId: "u1" },
      content: { kind: "attachment", url: "https://a.test/x.pdf", mediaType: "file" },
    });
    expect(m.sendAttachment).toHaveBeenCalledWith("tok", "ig_1", "u1", "https://a.test/x.pdf", "file");
  });

  it("a human agent reply carries the tag, and only as plain text to a person", async () => {
    await send(ctx, {
      to: { kind: "user", userId: "u1" },
      content: { kind: "text", text: "Sorry for the wait" },
      humanAgent: true,
    });
    expect(m.sendDirectMessage).toHaveBeenCalledWith("tok", "ig_1", "u1", "Sorry for the wait", {
      humanAgent: true,
    });

    await expect(
      send(ctx, {
        to: { kind: "comment", commentId: "c1" },
        content: { kind: "text", text: "no" },
        humanAgent: true,
      })
    ).rejects.toBeInstanceOf(UnsupportedContentError);
  });

  it("a public reply posts under the comment", async () => {
    m.sendCommentReply.mockResolvedValue({ id: "reply_1" });
    await expect(
      instagramAdapter.messaging.publicReply(ctx, { commentId: "c1", text: "Sent!" })
    ).resolves.toEqual({ id: "reply_1" });
    expect(m.sendCommentReply).toHaveBeenCalledWith("tok", "c1", "Sent!");
  });
});

describe("send: what Instagram cannot carry is refused before any call", () => {
  const nothingSent = (): void => {
    for (const fn of Object.values(m)) expect(fn).not.toHaveBeenCalled();
  };

  it("a file as a private reply", async () => {
    await expect(
      send(ctx, {
        to: { kind: "comment", commentId: "c1" },
        content: { kind: "attachment", url: "https://a.test/x.png", mediaType: "image" },
      })
    ).rejects.toBeInstanceOf(UnsupportedContentError);
    nothingSent();
  });

  it("a postback beside a link, or two postbacks", async () => {
    for (const buttons of [
      [
        { type: "postback" as const, title: "A", payload: "x" },
        { type: "url" as const, title: "B", url: "https://b.test" },
      ],
      [
        { type: "postback" as const, title: "A", payload: "x" },
        { type: "postback" as const, title: "B", payload: "y" },
      ],
    ]) {
      await expect(
        send(ctx, { to: { kind: "user", userId: "u1" }, content: { kind: "buttons", text: "t", buttons } })
      ).rejects.toBeInstanceOf(UnsupportedContentError);
    }
    nothingSent();
  });

  it("a button message with no buttons", async () => {
    await expect(
      send(ctx, { to: { kind: "user", userId: "u1" }, content: { kind: "buttons", text: "t", buttons: [] } })
    ).rejects.toBeInstanceOf(UnsupportedContentError);
    nothingSent();
  });
});

describe("webhook events", () => {
  const ACCOUNT = "17841400000000000";

  it("normalises every field into the shared shape, in handling order", () => {
    const events = instagramAdapter.webhook.parse({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          changes: [
            {
              field: "comments",
              value: { id: "c1", text: "LINK", from: { id: "u1", username: "ana" }, media: { id: "m1" } },
            },
          ],
          messaging: [
            {
              sender: { id: "u2" },
              recipient: { id: ACCOUNT },
              timestamp: 2,
              message: { mid: "mid_2", text: "PRICE" },
            },
            {
              sender: { id: "u3" },
              recipient: { id: ACCOUNT },
              timestamp: 3,
              postback: { mid: "mid_3", payload: "reveal:a1", title: "Send" },
            },
          ],
        },
      ],
    });

    expect(events.map((event) => event.type)).toEqual(["comment", "postback", "message"]);
    expect(events[0]).toMatchObject({
      type: "comment",
      platform: "INSTAGRAM",
      surface: "feed",
      accountExternalId: ACCOUNT,
      commentId: "c1",
      text: "LINK",
      authorId: "u1",
      authorName: "ana",
      mediaId: "m1",
    });
    expect(events[1]).toMatchObject({ type: "postback", userId: "u3", payload: "reveal:a1", mid: "mid_3" });
    expect(events[2]).toMatchObject({ type: "message", messageId: "mid_2", text: "PRICE", senderId: "u2", kind: "dm" });
  });

  it("returns nothing for a payload that is not Instagram's", () => {
    expect(instagramAdapter.webhook.parse({ object: "page", entry: [] })).toEqual([]);
    expect(instagramAdapter.webhook.parse(null)).toEqual([]);
    expect(instagramAdapter.webhook.accepts({ object: "page" })).toBe(false);
    expect(instagramAdapter.webhook.accepts({ object: "instagram" })).toBe(true);
  });

  it("stores only the entries of accounts this deployment knows", () => {
    const scoped = instagramAdapter.webhook.scopePayload(
      { object: "instagram", entry: [{ id: "mine", time: 1 }, { id: "someone_else", time: 1 }] },
      new Set(["mine"])
    );
    expect(scoped).toEqual({ object: "instagram", entry: [{ id: "mine", time: 1 }] });
  });

  it("answers Meta's handshake only with the right verify token", () => {
    vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "secret_token");
    const params = (token: string): URLSearchParams =>
      new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "42" });
    expect(instagramAdapter.webhook.verifyChallenge(params("secret_token"))).toBe("42");
    expect(instagramAdapter.webhook.verifyChallenge(params("wrong"))).toBeNull();
    vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "");
    expect(instagramAdapter.webhook.verifyChallenge(params(""))).toBeNull();
  });

  it("accepts only a body signed with the app secret", () => {
    vi.stubEnv("FACEBOOK_APP_SECRET", "app_secret");
    const body = JSON.stringify({ object: "instagram", entry: [] });
    const good = "sha256=" + createHmac("sha256", "app_secret").update(body).digest("hex");
    expect(instagramAdapter.webhook.verifySignature(body, new Headers({ "x-hub-signature-256": good }))).toBe(true);
    expect(instagramAdapter.webhook.verifySignature(body, new Headers({ "x-hub-signature-256": "sha256=00" }))).toBe(false);
    expect(instagramAdapter.webhook.verifySignature(body, new Headers())).toBe(false);
  });
});

describe("error rules", () => {
  const { errors } = instagramAdapter;

  it("only explicit refusals count as confirmed, never Meta code 1", () => {
    expect(errors.isConfirmedRejection(new RateLimitError("slow down"))).toBe(true);
    expect(errors.isConfirmedRejection(new TokenExpiredError("expired"))).toBe(true);
    expect(errors.isConfirmedRejection(new MetaApiError(100, undefined, undefined, "bad"))).toBe(true);
    expect(errors.isConfirmedRejection(new MetaApiError(1, undefined, undefined, "unknown"))).toBe(false);
    expect(errors.isConfirmedRejection(new Error("socket hang up"))).toBe(false);
  });

  it("turns anything unconfirmed into a delivery-unconfirmed error", () => {
    expect(isDeliveryUnconfirmed(classifySendError(errors, new Error("reset")))).toBe(true);
    const refused = new RateLimitError("slow down");
    expect(classifySendError(errors, refused)).toBe(refused);
  });

  it("falls back to text only for a genuine template rejection", () => {
    expect(errors.isRichContentRejection(new MetaApiError(100, undefined, undefined, "Unsupported message template"))).toBe(true);
    expect(errors.isRichContentRejection(new MetaApiError(100, undefined, undefined, "Message sent outside of allowed window, template"))).toBe(false);
    expect(errors.isRichContentRejection(new MetaApiError(1, undefined, undefined, "template"))).toBe(false);
  });

  it("recognises the error text older workers logged for an uncertain send", () => {
    expect(errors.isLegacyUnconfirmed("MetaApiError 1: An unknown error has occurred.")).toBe(true);
    expect(errors.isLegacyUnconfirmed("MetaApiError 100: bad")).toBe(false);
    expect(errors.isLegacyUnconfirmed(null)).toBe(false);
  });
});

describe("registry and capabilities", () => {
  it("has an adapter for every platform, and routes Meta payloads to it", () => {
    for (const platform of CHANNEL_PLATFORMS) {
      expect(getChannelAdapter(platform).platform).toBe(platform);
    }
    expect(adapterForWebhookPayload({ object: "instagram", entry: [] })).toBe(instagramAdapter);
    expect(adapterForWebhookPayload({ object: "whatsapp_business_account" })).toBeNull();
  });

  it("opens a context from the stored row by decrypting its token", async () => {
    const { adapter, context } = await openChannel({
      platform: "INSTAGRAM",
      instagramId: "ig_9",
      accessToken: "cipher",
    });
    expect(adapter).toBe(instagramAdapter);
    expect(context).toEqual({ platform: "INSTAGRAM", accountExternalId: "ig_9", accessToken: "plain:cipher" });
  });

  it("offers every campaign feature on Instagram", () => {
    const support = campaignFeatureSupport(getChannelCapabilities("INSTAGRAM"));
    expect(Object.values(support).every(Boolean)).toBe(true);
  });

  it("hides what a platform cannot do", () => {
    const base = getChannelCapabilities("INSTAGRAM");
    const limited: ChannelCapabilities = {
      ...base,
      privateReply: false,
      followGate: false,
      buttons: { ...base.buttons, postback: false },
      quickReplies: { ...base.quickReplies, supported: false },
      triggers: { ...base.triggers, storyReply: false },
    };
    const support = campaignFeatureSupport(limited);
    expect(support.commentTrigger).toBe(false);
    expect(support.openingDm).toBe(false);
    // The follow gate needs a button to re-check on, as well as the check.
    expect(campaignFeatureSupport({ ...base, buttons: { ...base.buttons, postback: false } }).followGate).toBe(false);
    expect(support.quickReplies).toBe(false);
    expect(support.storyReplyTrigger).toBe(false);
    expect(support.dmKeywordTrigger).toBe(true);
  });
});
