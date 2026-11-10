import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithLinkButton,
  mockSendPrivateReplyWithButton,
  mockGetUserFollowStatus,
  mockSendDirectMessageWithButton,
  mockSendDirectMessage,
  mockSendDirectMessageWithLinkButton,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockReleaseDMSlot,
  mockQueueAdd,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    postbackDelivery: { create: vi.fn(), delete: vi.fn() },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    instagramAccount: {
      findUnique: vi.fn(),
    },
    // Read on every send to check whether the person replied STOP.
    contact: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    operationalEvent: {
      create: vi.fn(),
    },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockReleaseDMSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  getUserFollowStatus: mockGetUserFollowStatus,
  sendDirectMessageWithButton: mockSendDirectMessageWithButton,
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
  sendCommentReply: vi.fn(),
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  },
  TokenExpiredError: class TokenExpiredError extends Error {
    name = "TokenExpiredError";
  },
  RateLimitError: class RateLimitError extends Error {
    name = "RateLimitError";
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecryptToken,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
  releaseDMSlot: mockReleaseDMSlot,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    add: mockQueueAdd,
  }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }
  return {
    Worker: MockWorker,
    UnrecoverableError: class UnrecoverableError extends Error {
      name = "UnrecoverableError";
    },
  };
});

import { MetaApiError, RateLimitError } from "@/lib/meta/client";
import { createDMWorker } from "../lib/queue/dm-worker";
import { getRedisConnection } from "@/lib/queue/client";
import { hashRecipientId } from "@/lib/tracking/server";
import { DEFAULT_FOLLOW_PROMPT } from "@/lib/campaigns/follow-prompt";

const usagePeriodStart = new Date("2026-05-01T00:00:00.000Z");

const mockAutomation = {
  id: "auto_789",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  postId: "media_101",
  keywords: ["LINK", "PRICE"],
  dmMessage: "Hey {username}! Here is the link: https://example.com",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    platform: "INSTAGRAM",
    accessToken: "encrypted_token_abc",
  },
  workspace: {
    id: "workspace_123",
  },
  trackedLinks: [],
};

const mockJobData = {
  instagramAccountId: "ig_456",
  commentId: "comment_555",
  commentText: "I want the LINK!",
  commenterId: "commenter_999",
  commenterName: "commenter_user",
  mediaId: "media_101",
};

function getProcessor(): (job: {
  name?: string;
  data: typeof mockJobData | Record<string, unknown>;
  id: string;
  attemptsMade: number;
}) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: {
    name?: string;
    data: typeof mockJobData | Record<string, unknown>;
    id: string;
    attemptsMade: number;
  }) => Promise<void>;
}

function createMockJob(data: Record<string, unknown> = mockJobData) {
  return {
    data,
    id: "job_001",
    attemptsMade: 0,
  };
}

function createMockPostbackJob(
  data: Record<string, unknown> = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "reveal:auto_789",
  }
) {
  return {
    name: "process-postback",
    data,
    id: "postback_job_001",
    attemptsMade: 0,
  };
}

/**
 * Make automation.findMany honour the trigger flag the worker filters on, the
 * way Postgres would. Without it the mock answers every query with the same
 * campaign, so the default-reply fallback appears to fire for messages that
 * matched nothing, and a story-reply query returns DM campaigns.
 */
const TRIGGER_FLAGS = [
  "storyReplyEnabled",
  "storyMentionEnabled",
  "defaultReplyEnabled",
  "liveCommentEnabled",
] as const;

function returnAutomationRespectingTriggers(fixture: Record<string, unknown>) {
  mockPrisma.automation.findMany.mockImplementation(
    (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      const optIn = TRIGGER_FLAGS.find((flag) => where[flag] === true);
      if (optIn && !fixture[optIn]) return Promise.resolve([]);
      return Promise.resolve([fixture]);
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.postbackDelivery.create.mockReset().mockResolvedValue({});
  mockPrisma.postbackDelivery.delete.mockReset().mockResolvedValue({});

  returnAutomationRespectingTriggers(mockAutomation);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.create.mockResolvedValue({});
  // Two different lookups share findFirst: the cross-campaign private-reply
  // check (keyed on status SENT) and the postback's name lookup. Only the
  // latter should resolve by default, or every comment would look like a
  // duplicate of an already-answered one.
  mockPrisma.dmLog.findFirst.mockImplementation(
    async (args: { where?: { status?: string } } = {}) =>
      args.where?.status === "SENT" ? null : { commenterName: "commenter_user" }
  );
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockReset().mockResolvedValue({});
  mockPrisma.dmLog.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_123",
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  // Nobody has opted out by default. The tests that care set this themselves.
  mockPrisma.contact.findUnique.mockResolvedValue(null);
  mockPrisma.contact.upsert.mockResolvedValue({});
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: usagePeriodStart,
  });
  mockReserveDMSlot.mockResolvedValue({
    allowed: true,
    currentCount: 11,
    remainingDMs: 179,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  mockReleaseDMSlot.mockResolvedValue(0);
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendPrivateReply.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_001",
  });
  mockSendPrivateReplyWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_002",
  });
  mockSendPrivateReplyWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_003",
  });
  mockSendDirectMessageWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_004",
  });
  mockSendDirectMessage.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_005",
  });
  mockSendDirectMessageWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_006",
  });
  mockGetUserFollowStatus.mockResolvedValue(true);
});

describe("DM Worker, comments left on an ad", () => {
  it("also matches the organic post the ad was created from", async () => {
    const processor = getProcessor();

    // A boosted post: the comment carries the ad's media id, while the
    // campaign is bound to the post the ad was made from. Without the second
    // id in the query the comment matches nothing and is dropped silently.
    await processor(
      createMockJob({
        ...mockJobData,
        mediaId: "ad_media_999",
        originalMediaId: "media_101",
      })
    );

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { postId: "ad_media_999" },
            { postId: "media_101" },
            { matchAnyPost: true },
          ],
        }),
      })
    );
    expect(mockSendPrivateReply).toHaveBeenCalled();
  });
});

describe("DM Worker, Full Pipeline", () => {
  it("should send a private reply for a matching comment", async () => {
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ postId: "media_101" }, { matchAnyPost: true }],
        isActive: true,
        instagramAccount: { instagramId: "ig_456" },
      },
      include: {
        instagramAccount: true,
        workspace: true,
        trackedLinks: {
          select: {
            slug: true,
            label: true,
            destinationUrl: true,
          },
          // Button order: position first, with createdAt and id only as
          // tie breakers, so tied rows can never come back swapped.
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(mockMatchKeywords).toHaveBeenCalledWith(
      "I want the LINK!",
      ["LINK", "PRICE"],
      true
    );
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReserveDMSlot).toHaveBeenCalledWith("ig_456", 0);
    // A successful send keeps its slot; the release path is failure-only.
    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
    expect(mockDecryptToken).toHaveBeenCalledWith("encrypted_token_abc");
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("should skip when no automations match the media", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("should skip when keywords do not match", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip duplicate comments already sent", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_log",
      status: "SENT",
    });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip when monthly plan limit is reached", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 100,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should requeue and release monthly usage when rate limited", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: 1800000,
      shouldSkip: false,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({
        commentId: "comment_555",
        requeueAttempt: 1,
      }),
      expect.objectContaining({
        delay: 1800000,
        jobId: "comment_ig_456_comment_555_retry_1",
      })
    );
  });

  it("should skip with SKIPPED_RATE_LIMIT after max requeue attempts", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }),
      })
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should log FAILED, release usage, and re-throw when private reply sending fails", async () => {
    const error = new RateLimitError("API Error");
    mockSendPrivateReply.mockRejectedValue(error);

    const processor = getProcessor();

    await expect(processor(createMockJob())).rejects.toThrow("API Error");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "API Error",
      }),
    });
  });

  it("should handle missing access token", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          accessToken: null,
        },
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        }),
      })
    );
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should use 'there' when commenter name is not available", async () => {
    const processor = getProcessor();
    const jobDataWithoutName = {
      instagramAccountId: mockJobData.instagramAccountId,
      commentId: mockJobData.commentId,
      commentText: mockJobData.commentText,
      commenterId: mockJobData.commenterId,
      mediaId: mockJobData.mediaId,
    };

    await processor(createMockJob(jobDataWithoutName as typeof mockJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey there! Here is the link: https://example.com"
    );
  });

  it("should deliver tracked links as web_url buttons (one or two)", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
          {
            slug: "def456",
            label: "Book a call",
            destinationUrl: "https://example.com/book",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Primary button title comes from linkButtonLabel; the second from its
    // own stored label. Both point at their tracked /r/<slug> URLs, tagged
    // with the commenter's recipient token.
    const token = hashRecipientId(mockJobData.commenterId);
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        { title: "Get offer", url: `http://localhost:3000/r/abc123?r=${token}` },
        { title: "Book a call", url: `http://localhost:3000/r/def456?r=${token}` },
      ]
    );
  });

  it("should send a follow-gate prompt when a non-follower comments", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false); // not following yet
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first {username}, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // The follow prompt goes out with a `followcheck:` postback button; the
    // link is NOT delivered yet.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Follow me first commenter_user, then tap 👇",
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should skip the prompt and send the link when the commenter already follows", async () => {
    mockGetUserFollowStatus.mockResolvedValue(true); // already following
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Confirmed follower: no prompt, link delivered right away.
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        {
          title: "Get offer",
          url: `http://localhost:3000/r/abc123?r=${hashRecipientId(mockJobData.commenterId)}`,
        },
      ]
    );
  });

  it("should send the opening DM first (routing to the follow check) when both opening DM and follow-gate are on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        openingDmEnabled: true,
        openingDmMessage: "Hey {username}, welcome!",
        openingDmButtonLabel: "Get the link",
        requireFollow: true,
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Opening DM goes out first; its button routes into the follow check.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user, welcome!",
      "Get the link",
      "followcheck:auto_789:open"
    );
    // Follow status is verified on the tap, not at comment time.
    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
  });

  it("should deliver the next DM from a read fallback when no button tap has sent it yet", async () => {
    // This person wrote to the account recently, so their window is open.
    mockPrisma.contact.findUnique.mockResolvedValue({ optedOutAt: null, lastInboundAt: new Date() });
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockPrisma.dmLog.findUnique).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
        },
      },
    });
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not deliver a read fallback when the button tap already sent the reveal", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_reveal",
      status: "SENT",
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback bypass the follow gate", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(false); // still not following

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    // Non-follower on a read fallback: no link, and no re-prompt spam either.
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback through when follow status is unverifiable", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    // Instagram answers "User consent is required" until the person taps a
    // button, which is exactly the case of someone who only read the DM.
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("should deliver a follow-gated read fallback once the user follows", async () => {
    // This person wrote to the account recently, so their window is open.
    mockPrisma.contact.findUnique.mockResolvedValue({ optedOutAt: null, lastInboundAt: new Date() });
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(true);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not log a failure when a read fallback hits a closed messaging window", async () => {
    // This person wrote to the account recently, so their window is open.
    mockPrisma.contact.findUnique.mockResolvedValue({ optedOutAt: null, lastInboundAt: new Date() });
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(10, undefined, undefined, "This message is sent outside of allowed window.")
    );

    const processor = getProcessor();
    // The window cannot reopen on its own, so this must not throw (no retries)
    // and must not leave a FAILED row the user can do nothing about.
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        })
      )
    ).resolves.toBeUndefined();

    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalled();
  });

  it("should still log a failure for a real button tap that fails", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(new Error("boom"));

    const processor = getProcessor();
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
        })
      )
    ).rejects.toThrow("boom");

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("DM Worker, one private reply per comment", () => {
  it("should skip a campaign when another already used the comment's private reply", async () => {
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string } } = {}) =>
        args.where?.status === "SENT"
          ? { automation: { name: "openreply 1" } }
          : { commenterName: "commenter_user" }
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          errorMessage: expect.stringContaining("openreply 1"),
        }),
      })
    );
  });

  it("should not fall back to a plain-text private reply when the window is the problem", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "The comment is invalid for a private reply")
    );

    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow(
      "The comment is invalid for a private reply"
    );

    // The reserved rate slot must be handed back when the send fails, so a
    // comment that never delivered a DM does not burn slots on each retry.
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");

    // A text retry on the same comment would fail identically and overwrite the
    // real reason, so it must not be attempted.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorMessage: expect.stringContaining("The comment is invalid for a private reply"),
        }),
      })
    );
  });

  it("should still fall back to plain text when the button template itself is rejected", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Unsupported message template")
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      })
    );
  });
});

describe("DM Worker, DM keyword trigger", () => {
  const dmTriggerAutomation = {
    ...mockAutomation,
    dmTriggerEnabled: true,
    requireFollow: false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
  };

  function createMockMessageJob(data: Record<string, unknown> = {}) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_abc",
        messageText: "can I get the LINK?",
        senderId: "commenter_999",
        ...data,
      },
      id: "message_job_001",
      attemptsMade: 0,
    };
  }

  beforeEach(() => {
    returnAutomationRespectingTriggers(dmTriggerAutomation);
  });

  it("should reply to a DM whose text matches the campaign keywords", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dmTriggerEnabled: true,
          isActive: true,
        }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    // Never a private reply, there is no comment to reply to.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should not reply when the DM text matches no keyword", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });

    const processor = getProcessor();
    await processor(createMockMessageJob({ messageText: "hello there" }));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });

  it("selects story-reply campaigns, not DM campaigns, for a story reply", async () => {
    returnAutomationRespectingTriggers({
      ...dmTriggerAutomation,
      storyReplyEnabled: true,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob({ kind: "story_reply" }));

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ storyReplyEnabled: true }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalled();
  });

  it("does not answer a story reply with a DM-trigger campaign", async () => {
    // The fixture opts into DM triggers only, so a story reply finds nothing.
    const processor = getProcessor();
    await processor(createMockMessageJob({ kind: "story_reply" }));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("fires on a story mention even though it carries no text", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    returnAutomationRespectingTriggers({
      ...dmTriggerAutomation,
      storyMentionEnabled: true,
    });

    const processor = getProcessor();
    await processor(
      createMockMessageJob({ kind: "story_mention", messageText: "" })
    );

    // Being mentioned is the trigger, so the keyword matcher is bypassed.
    expect(mockSendDirectMessage).toHaveBeenCalled();
  });

  it("falls back to the default-reply campaign when nothing matched", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    returnAutomationRespectingTriggers({
      ...dmTriggerAutomation,
      defaultReplyEnabled: true,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob({ messageText: "unrecognised" }));

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ defaultReplyEnabled: true }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalled();
  });

  it("does not fall back for a story mention that matched nothing", async () => {
    // A generic "did not understand" reply to a story mention would be noise.
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    returnAutomationRespectingTriggers({
      ...dmTriggerAutomation,
      defaultReplyEnabled: true,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob({ kind: "story_mention" }));

    expect(mockPrisma.automation.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ defaultReplyEnabled: true }),
      })
    );
  });

  it("should log the reply against the inbound message id for dedup", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId_commentId: {
            automationId: "auto_789",
            commentId: "dm:mid_abc",
          },
        },
        create: expect.objectContaining({
          commenterId: "commenter_999",
          commentText: "can I get the LINK?",
          matchedKeyword: "LINK",
          status: "SENT",
        }),
      })
    );
  });

  it("should not re-send when this message was already answered", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT" });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should send the link as buttons when the campaign has tracked links", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        linkButtonLabel: "Get it",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Get it",
            destinationUrl: "https://example.com/offer",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should send the follow prompt instead of the link to a non-follower", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      expect.any(String),
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  // First contact, so the gate is fail-closed like processComment: an
  // unverifiable status must not hand out the link.
  it("should send the follow prompt when follow status cannot be verified", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should skip and log when the workspace is over its monthly limit", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 2000,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should release the usage reservation and rethrow when the send fails", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("Meta is down"));

    const processor = getProcessor();
    await expect(processor(createMockMessageJob())).rejects.toThrow(
      "Meta is down"
    );

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("DM Worker, the default follow-gate prompt", () => {
  it("sends neutral copy when the campaign wrote no prompt of its own", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...mockAutomation, requireFollow: true, followPromptMessage: null },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
    const text = mockSendPrivateReplyWithButton.mock.calls[0][3] as string;
    expect(text).toBe(DEFAULT_FOLLOW_PROMPT);
    // Every business on the platform inherits this text, so it must not
    // promote anything of ours.
    expect(text.toLowerCase()).not.toMatch(/github|star the repo|support me/);
  });
});

describe("DM Worker, the platform's messaging windows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips a comment's private reply past the 7 day window, and records why", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-20T12:00:00Z"), toFake: ["Date"] });
    // A copy: createMockJob shares one data object across tests.
    const base = createMockJob();
    const job = { ...base, data: { ...base.data, commentCreatedAt: "2026-09-10T12:00:00Z" } };

    await getProcessor()(job);

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_WINDOW_CLOSED" }),
      })
    );
  });

  it("still sends a private reply inside the window", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-12T12:00:00Z"), toFake: ["Date"] });
    // A copy: createMockJob shares one data object across tests.
    const base = createMockJob();
    const job = { ...base, data: { ...base.data, commentCreatedAt: "2026-09-10T12:00:00Z" } };

    await getProcessor()(job);

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("does not apply the 7 day rule to a Live comment, which has its own", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, liveCommentEnabled: true }]);
    const base = createMockJob();
    const job = {
      ...base,
      data: { ...base.data, source: "LIVE", commentCreatedAt: "2026-01-01T00:00:00Z" },
    };

    await getProcessor()(job);

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("never sends a read fallback to someone who has not written in", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({ ...mockAutomation, trackedLinks: [] });
    mockPrisma.contact.findUnique.mockResolvedValue({ optedOutAt: null, lastInboundAt: null });

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    // Reading a private reply is not answering it, so nothing may follow.
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("does not answer a button tap whose job sat past the 24 hour window", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-03T12:00:00Z"), toFake: ["Date"] });
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({ ...mockAutomation, trackedLinks: [] });

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        receivedAt: "2026-09-01T12:00:00Z",
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("does not send a follow-up once the window has closed", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-03T15:00:00Z"), toFake: ["Date"] });
    mockPrisma.contact.findUnique.mockResolvedValue({
      optedOutAt: null,
      lastInboundAt: new Date("2026-09-01T12:00:00Z"),
    });
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      followUpEnabled: true,
      followUpMessage: "Thanks again",
      workspace: { id: "workspace_123", timezone: "UTC", quietHoursEnabled: false, quietHoursStart: 21, quietHoursEnd: 9 },
    });

    await getProcessor()({
      name: "process-followup",
      data: { instagramAccountId: "ig_456", userId: "commenter_999", automationId: "auto_789" },
      id: "followup_job_002",
      attemptsMade: 0,
    });

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("DM Worker, follow-ups held for quiet hours", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requeues a held follow-up under the name the worker routes to the follow-up handler", async () => {
    // 03:00 UTC, inside the default 21:00 to 09:00 quiet window.
    vi.useFakeTimers({ now: new Date("2026-09-01T03:00:00Z"), toFake: ["Date"] });
    // They tapped the reveal an hour ago, so the window is open.
    mockPrisma.contact.findUnique.mockResolvedValue({
      optedOutAt: null,
      lastInboundAt: new Date("2026-09-01T02:00:00Z"),
    });
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      followUpEnabled: true,
      followUpMessage: "Thanks for grabbing it",
      workspace: {
        id: "workspace_123",
        timezone: "UTC",
        quietHoursEnabled: true,
        quietHoursStart: 21,
        quietHoursEnd: 9,
      },
    });

    const followUp = {
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      automationId: "auto_789",
    };
    await getProcessor()({
      name: "process-followup",
      data: followUp,
      id: "followup_job_001",
      attemptsMade: 0,
    });

    // Any other name falls through the dispatcher to the comment handler,
    // which drops a follow-up on the floor instead of sending it at 09:00.
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-followup",
      followUp,
      expect.objectContaining({ delay: expect.any(Number) })
    );
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("DM Worker, a person who said stop", () => {
  it("does not reply to someone who opted out, even when they comment the keyword", async () => {
    mockPrisma.contact.findUnique.mockResolvedValue({
      optedOutAt: new Date("2026-09-01T10:00:00Z"),
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_OPTED_OUT" }),
      })
    );
  });

  it("spends no budget and no rate-limit slot on them", async () => {
    mockPrisma.contact.findUnique.mockResolvedValue({
      optedOutAt: new Date("2026-09-01T10:00:00Z"),
    });

    const processor = getProcessor();
    await processor(createMockJob());

    // Checked before either reservation on purpose: someone who opted out
    // should not consume the workspace's monthly allowance or a slot against
    // Meta's hourly cap.
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockReserveDMSlot).not.toHaveBeenCalled();
  });

  it("still replies normally to everyone else", async () => {
    mockPrisma.contact.findUnique.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReserveWorkspaceDMSend).toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_OPTED_OUT" }),
      })
    );
  });
});
it("stops BullMQ retries after an ambiguous direct-message outcome", async () => {
  mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
  // A dropped connection after the request left says nothing about whether
  // Instagram delivered it, so this must never be retried automatically.
  mockSendDirectMessage.mockRejectedValueOnce(new Error("connection reset"));
  await expect(getProcessor()(createMockPostbackJob())).rejects.toMatchObject({
    name: "UnrecoverableError",
    message: expect.stringContaining("Inspect the Instagram inbox"),
  });
  expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
});

it('binds queued comments to the local connection that received them', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([]);
  const job = createMockJob();
  Object.assign(job.data, { accountConnectionId: 'original-connection' });
  await getProcessor()(job);
  expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instagramAccountId: 'original-connection' }) }));
});

it('never automatically resends a private reply with an unconfirmed delivery', async () => {
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'FAILED', dmDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockSendPrivateReply).not.toHaveBeenCalled();
  expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

it('keeps an unconfirmed public reply untouched after the DM was delivered', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, publicReplyEnabled: true, publicReplyMessage: 'Thanks!', publicReplyMessages: [] }]);
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'SENT', publicReplyDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

describe("durable postback delivery", () => {
  beforeEach(() => {
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      },
    );
    mockPrisma.postbackDelivery.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        claims.delete(where.id);
      },
    );
    mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
    mockSendDirectMessage.mockResolvedValue({ recipient_id: "commenter_999", message_id: "sent" });
  });

  function tap(mid: string) {
    return createMockPostbackJob({
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "reveal:auto_789",
      mid,
    });
  }

  it("retains an uncertain tap across a newer successful tap and queue eviction", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(new Error("connection reset"));
    const process = getProcessor();
    await expect(process(tap("old"))).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    await process(tap("new"));
    await process({ ...tap("old"), id: "redelivery-job" });
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
  });

  it("deduplicates successful old taps while permitting each distinct new mid", async () => {
    const process = getProcessor();
    await process(tap("first"));
    await process(tap("second"));
    await process({ ...tap("first"), id: "after-retention" });
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
  });

  it("releases a claim on a confirmed rejection so the same tap can retry", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(new RateLimitError("rate limited"));
    const process = getProcessor();
    await expect(process(tap("retry"))).rejects.toThrow();
    await process(tap("retry"));
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledTimes(1);
  });

  it("claims concurrent deliveries of the same tap before either can send twice", async () => {
    const process = getProcessor();
    await Promise.all([
      process(tap("concurrent")),
      process({ ...tap("concurrent"), id: "other-job" }),
    ]);
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates follow-gate prompts as well as reveal messages", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
    });
    mockGetUserFollowStatus.mockResolvedValue(false);
    mockSendDirectMessageWithButton.mockResolvedValue({ recipient_id: "commenter_999", message_id: "prompt" });
    const process = getProcessor();
    const followTap = tap("follow");
    // The prompt goes out on the last delayed re-check (an earlier false only
    // queues the next one), so exercise that pass: that is where the prompt is
    // sent, and where a redelivery must not send it a second time.
    followTap.data = {
      ...followTap.data,
      payload: "followcheck:auto_789",
      followRecheck: true,
      followRecheckAttempt: 2,
    };
    await process(followTap);
    await process({ ...followTap, id: "redelivery" });
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
  });
});

describe("DM Worker, follow-gate re-check", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };

  it("re-checks a first false follow later instead of rejecting the tap", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
      })
    );

    // Nothing is sent yet: a brand-new follow may simply not have registered.
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheck: true, userId: "commenter_999" }),
      expect.objectContaining({ delay: expect.any(Number) })
    );
  });

  it("prompts and records the rejection when the last re-check still finds no follow", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        followRecheck: true,
        followRecheckAttempt: 2,
      })
    );

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          message: "Follow gate rejected a button tap",
        }),
      })
    );
    // A re-check never queues another re-check.
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("buckets the re-check id by time so a later tap is not blocked by an old job", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
      })
    );

    const [,, opts] = mockQueueAdd.mock.calls[0];
    // A fixed per-user id would collide with the retained completed job of an
    // earlier re-check and be dropped silently by BullMQ.
    expect(opts.jobId).toMatch(/^postback_recheck_auto_789_commenter_999_1_\d+$/);
  });

  it("checks twice: soon after the tap, then again before giving up", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
    const tap = {
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "followcheck:auto_789",
    };

    await getProcessor()(createMockPostbackJob(tap));
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.objectContaining({ delay: 20_000 })
    );

    await getProcessor()(
      createMockPostbackJob({ ...tap, followRecheck: true, followRecheckAttempt: 1 })
    );
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 2 }),
      expect.objectContaining({ delay: 40_000 })
    );
    // Neither pass has given up yet, so neither re-sends the prompt.
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("treats a re-check queued before counting existed as the first one done", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        followRecheck: true,
      })
    );

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 2 }),
      expect.anything()
    );
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("prompts a non-follower right away when the tap came from the opening DM", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:open",
      })
    );

    // Tapping the opening DM is not a claim to follow, so there is nothing to
    // wait for: the follow prompt goes out now, not after the re-check delay.
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      expect.any(String),
      expect.any(String),
      "followcheck:auto_789"
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // Nor is it a rejection: they were never told to follow before this.
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });
});

describe("DM Worker, follow re-check acknowledgement", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };
  const tap = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "followcheck:auto_789",
  };
  const mockRedisSet = vi.fn();

  beforeEach(() => {
    process.env.FOLLOW_RECHECK_ACK_MESSAGE = "Dame unos segundos que lo verifico";
    mockRedisSet.mockReset().mockResolvedValue("OK");
    vi.mocked(getRedisConnection).mockReturnValue({ set: mockRedisSet } as never);
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
  });

  afterEach(() => {
    delete process.env.FOLLOW_RECHECK_ACK_MESSAGE;
  });

  it("answers a not-yet-visible follow right away instead of leaving the chat silent", async () => {
    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Dame unos segundos que lo verifico"
    );
    // The re-check is still what decides; the acknowledgement only fills the wait.
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.anything()
    );
  });

  it("acknowledges a burst of taps only once", async () => {
    mockRedisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await getProcessor()(createMockPostbackJob(tap));
    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge again on the re-check passes", async () => {
    await getProcessor()(
      createMockPostbackJob({ ...tap, followRecheck: true, followRecheckAttempt: 1 })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("still re-checks when the acknowledgement cannot be sent", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(new Error("boom"));

    await expect(getProcessor()(createMockPostbackJob(tap))).resolves.toBeUndefined();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.anything()
    );
  });

  it("sends nothing extra when no acknowledgement message is configured", async () => {
    delete process.env.FOLLOW_RECHECK_ACK_MESSAGE;

    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

describe("ambiguous Meta sends and durable comment claims", () => {
  const withLinks = { ...mockAutomation, trackedLinks: [{ slug: "resource", label: null, destinationUrl: "https://example.com" }] };

  it("never falls back or retries Meta code 1, even though Meta may have sent the message", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([withLinks]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(new MetaApiError(1, undefined, undefined, "An unknown error has occurred."));
    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", dmDeliveryUnconfirmed: true }) }));
    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
  });

  it("retains the fallback's uncertain outcome instead of replacing it with the first rejection", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([withLinks]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(new MetaApiError(100, undefined, undefined, "Unsupported message template"));
    mockSendPrivateReply.mockRejectedValue(new Error("Connection reset after send"));
    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({ name: "UnrecoverableError", message: expect.stringContaining("Connection reset after send") });
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dmDeliveryUnconfirmed: true }) }));
  });

  it("blocks the historical code 1 failures before any further network send", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "FAILED", attempts: 1, errorMessage: "MetaApiError 1: An unknown error has occurred.", dmDeliveryUnconfirmed: false });
    await getProcessor()(createMockJob());
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: { dmDeliveryUnconfirmed: true } }));
  });

  it("cannot reset the lifetime attempt limit by enqueueing a new job", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "FAILED", attempts: 3, dmDeliveryUnconfirmed: false });
    await getProcessor()({ ...createMockJob(), id: "new-poll-job", attemptsMade: 0 });
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
  });

  it("allows only the claim winner to send when webhook and polling overlap", async () => {
    let claimed = false;
    mockPrisma.dmLog.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    const process = getProcessor();
    await Promise.all([process(createMockJob()), process({ ...createMockJob(), id: "poll-job" })]);
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("keeps the pre-send claim when both success and failure log writes fail", async () => {
    mockPrisma.dmLog.update.mockRejectedValue(new Error("Database unavailable"));
    const process = getProcessor();
    await expect(process(createMockJob())).rejects.toThrow("Database unavailable");
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dmDeliveryUnconfirmed: true }) }));
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "PENDING", attempts: 1, dmDeliveryUnconfirmed: true });
    await process({ ...createMockJob(), id: "retry-after-db-recovers" });
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
  });

  it("does not send at all when storing the claim fails", async () => {
    mockPrisma.dmLog.updateMany.mockRejectedValue(new Error("Database unavailable"));
    await expect(getProcessor()(createMockJob())).rejects.toThrow("Database unavailable");
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });
});

it("deduplicates a redelivered Meta button tap after queue retention expires", async () => {
  const claims = new Set<string>();
  mockPrisma.postbackDelivery.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
    if (claims.has(data.id)) throw { code: "P2002" };
    claims.add(data.id);
    return data;
  });
  mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
  const data = { instagramAccountId: "ig_456", userId: "commenter_999", payload: "reveal:auto_789", mid: "same-meta-tap" };
  const process = getProcessor();
  await process(createMockPostbackJob(data));
  await process({ ...createMockPostbackJob(data), id: "redelivered-after-eviction" });
  expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
});

it("retains the public reply claim if sending succeeded but its log write failed", async () => {
  const { sendCommentReply } = await import("@/lib/meta/client");
  vi.mocked(sendCommentReply).mockResolvedValue({ id: "public-reply" });
  mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, publicReplyEnabled: true, publicReplyMessages: ["Sent!"] }]);
  mockPrisma.dmLog.update.mockRejectedValueOnce(new Error("Lost database connection after public send"));
  const process = getProcessor();
  await process(createMockJob());
  expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ publicReplyDeliveryUnconfirmed: true }) }));
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT", publicReplyDeliveryUnconfirmed: true });
  await process({ ...createMockJob(), id: "next-poll" });
  expect(sendCommentReply).toHaveBeenCalledTimes(1);
  expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
});
