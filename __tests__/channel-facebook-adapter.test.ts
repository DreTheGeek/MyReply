/**
 * The Facebook Page channel adapter: sends, events, connect, and the rules it
 * declares. The Graph client (lib/meta/facebook) is mocked, so these pin the
 * mapping from neutral calls onto Page API calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fb = vi.hoisted(() => ({
  sendPageMessage: vi.fn(),
  replyToPageComment: vi.fn(),
  setPageCommentHidden: vi.fn(),
  exchangeFacebookCode: vi.fn(),
  listManagedPages: vi.fn(),
  subscribePageToWebhooks: vi.fn(),
  getPageProfile: vi.fn(),
  getRecentPostComments: vi.fn(),
}));

vi.mock("@/lib/meta/facebook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/meta/facebook")>()),
  ...fb,
}));
vi.mock("@/lib/meta/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/meta/oauth")>()),
  decryptToken: (value: string) => `plain:${value}`,
}));

import type { ChannelContext } from "../lib/channels/adapter";
import { campaignFeatureSupport, getChannelCapabilities } from "../lib/channels/capabilities";
import { UnsupportedContentError } from "../lib/channels/content";
import { facebookAdapter } from "../lib/channels/facebook/adapter";
import { adapterForWebhookPayload, openChannel } from "../lib/channels/registry";

const PAGE = "page_1";
const ctx: ChannelContext = { platform: "FACEBOOK", accountExternalId: PAGE, accessToken: "ptok" };
const send = facebookAdapter.messaging.send;

beforeEach(() => {
  vi.clearAllMocks();
  fb.sendPageMessage.mockResolvedValue({ recipient_id: "psid_1", message_id: "m_1" });
});

describe("send", () => {
  it("a private reply to a comment goes to the Page's Send API by comment id", async () => {
    const receipt = await send(ctx, {
      to: { kind: "comment", commentId: "c1" },
      content: { kind: "text", text: "Here you go" },
    });
    expect(fb.sendPageMessage).toHaveBeenCalledWith(
      "ptok", PAGE, { comment_id: "c1" }, { kind: "text", text: "Here you go", quickReplies: undefined }, { humanAgent: false }
    );
    expect(receipt).toEqual({ messageId: "m_1", recipientId: "psid_1" });
  });

  it("a message to a person goes by their Page-scoped id", async () => {
    await send(ctx, { to: { kind: "user", userId: "psid_1" }, content: { kind: "text", text: "hi" } });
    expect(fb.sendPageMessage.mock.calls[0][2]).toEqual({ id: "psid_1" });
  });

  it("one postback button and link buttons map to their templates", async () => {
    await send(ctx, {
      to: { kind: "comment", commentId: "c1" },
      content: { kind: "buttons", text: "tap", buttons: [{ type: "postback", title: "Send it", payload: "reveal:a1" }] },
    });
    expect(fb.sendPageMessage.mock.calls[0][3]).toEqual({
      kind: "postback_button", text: "tap", title: "Send it", payload: "reveal:a1",
    });

    await send(ctx, {
      to: { kind: "user", userId: "psid_1" },
      content: { kind: "buttons", text: "links", buttons: [{ type: "url", title: "Book", url: "https://a.test" }] },
    });
    expect(fb.sendPageMessage.mock.calls[1][3]).toEqual({
      kind: "link_buttons", text: "links", buttons: [{ title: "Book", url: "https://a.test" }],
    });
  });

  it("refuses what it cannot carry before any call", async () => {
    await expect(
      send(ctx, {
        to: { kind: "comment", commentId: "c1" },
        content: { kind: "attachment", url: "https://a.test/x.png", mediaType: "image" },
      })
    ).rejects.toBeInstanceOf(UnsupportedContentError);
    await expect(
      send(ctx, {
        to: { kind: "comment", commentId: "c1" },
        content: { kind: "text", text: "x" },
        humanAgent: true,
      })
    ).rejects.toBeInstanceOf(UnsupportedContentError);
    expect(fb.sendPageMessage).not.toHaveBeenCalled();
  });

  it("a human agent reply carries the flag through", async () => {
    await send(ctx, { to: { kind: "user", userId: "psid_1" }, content: { kind: "text", text: "late" }, humanAgent: true });
    expect(fb.sendPageMessage.mock.calls[0][4]).toEqual({ humanAgent: true });
  });

  it("replies to and hides comments as the Page", async () => {
    fb.replyToPageComment.mockResolvedValue({ id: "r1" });
    await expect(facebookAdapter.messaging.publicReply(ctx, { commentId: "c1", text: "Sent!" })).resolves.toEqual({ id: "r1" });
    await facebookAdapter.moderation?.hideComment(ctx, "c1", true);
    expect(fb.setPageCommentHidden).toHaveBeenCalledWith("ptok", "c1", true);
  });
});

describe("webhook events", () => {
  const payload = {
    object: "page",
    entry: [
      {
        id: PAGE,
        time: 1,
        changes: [
          {
            field: "feed",
            value: {
              item: "comment", verb: "add", comment_id: "c1", post_id: "post_1",
              message: "PRICE", created_time: 1_762_000_000, from: { id: "psid_1", name: "Ana" },
            },
          },
          // The Page's own reply, which must never trigger a private reply.
          {
            field: "feed",
            value: { item: "comment", verb: "add", comment_id: "c2", post_id: "post_1", message: "thanks", from: { id: PAGE } },
          },
          // An edit is not a new comment.
          {
            field: "feed",
            value: { item: "comment", verb: "edited", comment_id: "c3", post_id: "post_1", message: "x", from: { id: "psid_2" } },
          },
        ],
        messaging: [
          { sender: { id: "psid_1" }, recipient: { id: PAGE }, timestamp: 2, message: { mid: "mid_1", text: "LINK" } },
          { sender: { id: "psid_3" }, recipient: { id: PAGE }, timestamp: 3, postback: { mid: "pb_1", payload: "reveal:a1" } },
          { sender: { id: PAGE }, recipient: { id: "psid_1" }, timestamp: 4, message: { mid: "mid_echo", text: "sent", is_echo: true } },
          { sender: { id: "psid_4" }, recipient: { id: PAGE }, timestamp: 5, referral: { ref: "spring-flyer", source: "SHORTLINK" } },
        ],
      },
    ],
  };

  it("normalises comments and messaging into channel events, in handling order", () => {
    const events = facebookAdapter.webhook.parse(payload);
    expect(events.map((event) => event.type)).toEqual(["comment", "referral", "postback", "message", "echo"]);
    expect(events[0]).toMatchObject({
      type: "comment",
      platform: "FACEBOOK",
      accountExternalId: PAGE,
      commentId: "c1",
      text: "PRICE",
      authorId: "psid_1",
      authorName: "Ana",
      mediaId: "post_1",
      createdAt: new Date(1_762_000_000 * 1000),
    });
    expect(events[4]).toMatchObject({ type: "echo", recipientId: "psid_1", messageId: "mid_echo" });
  });

  it("is chosen for Page payloads at the shared Meta endpoint", () => {
    expect(adapterForWebhookPayload(payload)).toBe(facebookAdapter);
    expect(facebookAdapter.webhook.parse({ object: "instagram", entry: [] })).toEqual([]);
  });

  it("stores only known Pages' entries", () => {
    const scoped = facebookAdapter.webhook.scopePayload(
      { object: "page", entry: [{ id: PAGE }, { id: "page_other" }] },
      new Set([PAGE])
    );
    expect(scoped).toEqual({ object: "page", entry: [{ id: PAGE }] });
  });
});

describe("connect", () => {
  it("returns a grant per Page the person can message from, with no expiry", async () => {
    fb.exchangeFacebookCode.mockResolvedValue("user_token");
    fb.listManagedPages.mockResolvedValue([
      { id: "p1", name: "Lash Studio", access_token: "pt1", tasks: ["MESSAGING", "MODERATE"] },
      { id: "p2", name: "Analytics only", access_token: "pt2", tasks: ["ANALYZE"] },
    ]);
    const grants = await facebookAdapter.auth.completeConnection({ code: "c", redirectUri: "https://x/cb" });
    expect(grants).toEqual([
      { externalId: "p1", username: "Lash Studio", name: "Lash Studio", accessToken: "pt1", expiresAt: null },
    ]);
  });

  it("opens a context from a stored Page row", async () => {
    const { adapter, context } = await openChannel({ platform: "FACEBOOK", instagramId: PAGE, accessToken: "cipher" });
    expect(adapter).toBe(facebookAdapter);
    expect(context).toEqual({ platform: "FACEBOOK", accountExternalId: PAGE, accessToken: "plain:cipher" });
  });
});

describe("capabilities", () => {
  it("offers comment-to-DM, DMs and public replies, but no follow gate or stories", () => {
    const support = campaignFeatureSupport(getChannelCapabilities("FACEBOOK"));
    expect(support.commentTrigger).toBe(true);
    expect(support.dmKeywordTrigger).toBe(true);
    expect(support.publicReply).toBe(true);
    expect(support.followGate).toBe(false);
    expect(support.storyReplyTrigger).toBe(false);
    expect(support.liveCommentTrigger).toBe(false);
  });

  it("declares Meta's windows: 7 day private reply, 24 hours, 7 day human agent", () => {
    expect(getChannelCapabilities("FACEBOOK").window).toEqual({
      standardHours: 24, privateReplyDays: 7, humanAgentDays: 7,
    });
  });
});
