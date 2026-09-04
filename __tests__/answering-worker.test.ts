import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Worker integration for customer answering.
 *
 * The assistant sits between "no campaign wanted this DM" and "send the default
 * reply". These tests pin the two things that must never change about that
 * position: it never speaks over a campaign, and it never costs a campaign its
 * send when it breaks.
 *
 * lib/ai/answering is mocked here on purpose. Its own policy is covered in
 * answering.test.ts; what is under test in this file is the wiring.
 */

const {
  mockPrisma,
  mockAnswerInboundMessage,
  mockGetAnsweringSettings,
  mockSendDirectMessage,
  mockDecryptToken,
  mockMatchKeywords,
  mockUpsertContact,
  mockRecordContactDm,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn(), findFirst: vi.fn() },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    instagramAccount: { findUnique: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockAnswerInboundMessage: vi.fn(),
  mockGetAnsweringSettings: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockUpsertContact: vi.fn(),
  mockRecordContactDm: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/ai/answering", () => ({
  answerInboundMessage: mockAnswerInboundMessage,
}));

vi.mock("@/lib/ai/answering-settings", () => ({
  getAnsweringSettings: mockGetAnsweringSettings,
}));

vi.mock("@/lib/meta/client", () => ({
  MetaApiError: class MetaApiError extends Error {},
  RateLimitError: class RateLimitError extends Error {},
  TokenExpiredError: class TokenExpiredError extends Error {},
  getUserFollowStatus: vi.fn(async () => true),
  sendCommentReply: vi.fn(),
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithButton: vi.fn(),
  sendDirectMessageWithLinkButton: vi.fn(),
  sendDirectMessageWithQuickReplies: vi.fn(),
  sendPrivateReply: vi.fn(),
  sendPrivateReplyWithButton: vi.fn(),
  sendPrivateReplyWithLinkButton: vi.fn(),
  sendAttachment: vi.fn(),
  inferAttachmentType: vi.fn(() => "image"),
}));

vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/contacts", () => ({
  upsertContact: mockUpsertContact,
  recordContactDm: mockRecordContactDm,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: vi.fn(async () => ({ allowed: true, reserved: true })),
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
  recordWorkerHeartbeat: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: vi.fn() }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__answeringWorkerProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }
  return { Worker: MockWorker };
});

import { createDMWorker } from "@/lib/queue/dm-worker";

interface TestJob {
  name: string;
  data: Record<string, unknown>;
  id: string;
  attemptsMade: number;
  timestamp: number;
}

function getProcessor(): (job: TestJob) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>)
    .__answeringWorkerProcessor as (job: TestJob) => Promise<void>;
}

const defaultReplyAutomation = {
  id: "auto_default",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  name: "Default reply",
  keywords: [],
  dmMessage: "Thanks for the message, we will get back to you.",
  isActive: true,
  wholeWordMatch: true,
  matchAnyWord: false,
  matchAnyPost: false,
  dmTriggerEnabled: true,
  defaultReplyEnabled: true,
  requireFollow: false,
  followUpEnabled: false,
  openingDmEnabled: false,
  publicReplyEnabled: false,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token",
  },
  workspace: { id: "workspace_123" },
  trackedLinks: [],
};

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

function messageJob(data: Record<string, unknown> = {}): TestJob {
  return {
    name: "process-message",
    data: {
      instagramAccountId: "ig_456",
      messageId: "mid_customer_1",
      messageText: "do you ship to ireland",
      senderId: "igsid_customer",
      ...data,
    },
    id: "job_1",
    attemptsMade: 0,
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  returnAutomationRespectingTriggers(defaultReplyAutomation);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token",
    workspaceId: "workspace_123",
    workspace: { name: "Acme" },
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});

  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
  mockUpsertContact.mockResolvedValue({ id: "contact_1" });
  mockRecordContactDm.mockResolvedValue(undefined);
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
  });
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendDirectMessage.mockResolvedValue({
    recipient_id: "igsid_customer",
    message_id: "msg_1",
  });

  mockGetAnsweringSettings.mockResolvedValue({
    enabled: true,
    confidenceThreshold: 0.6,
    autoPauseMinutes: 30,
    disclosure: "",
  });
  mockAnswerInboundMessage.mockResolvedValue({
    status: "declined",
    reason: "no_knowledge",
  });
});

describe("DM worker, assistant answering", () => {
  it("tries the assistant only after every campaign has declined", async () => {
    // This DM matches a keyword campaign, so nothing should reach the
    // assistant: a campaign that wanted the message keeps it.
    mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "SHIP" });

    const processor = getProcessor();
    await processor(messageJob());

    expect(mockAnswerInboundMessage).not.toHaveBeenCalled();
  });

  it("hands the assistant the account row, the contact and the sender", async () => {
    const processor = getProcessor();
    await processor(messageJob());

    expect(mockAnswerInboundMessage).toHaveBeenCalledTimes(1);
    const input = mockAnswerInboundMessage.mock.calls[0][0];
    expect(input.workspaceId).toBe("workspace_123");
    expect(input.workspaceName).toBe("Acme");
    // The row id, which is what AssistantAnswer stores, not the IG id.
    expect(input.instagramAccountId).toBe("ig_account_row_1");
    expect(input.contactId).toBe("contact_1");
    expect(input.recipientId).toBe("igsid_customer");
    expect(input.messageId).toBe("mid_customer_1");
    expect(input.question).toBe("do you ship to ireland");
    expect(input.customerMessageAt).toBeInstanceOf(Date);
  });

  it("does not also send the default reply when the assistant answered", async () => {
    mockAnswerInboundMessage.mockImplementation(
      async (input: { send: (text: string) => Promise<void> }) => {
        await input.send("We ship to Ireland in 5 working days.");
        return { status: "sent", answerId: "ans_1", confidence: 0.8, text: "..." };
      }
    );

    const processor = getProcessor();
    await processor(messageJob());

    // One message only. Two would be the assistant's answer plus the generic
    // fallback, which is exactly the double reply this ordering prevents.
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage.mock.calls[0][3]).toBe(
      "We ship to Ireland in 5 working days."
    );
    expect(mockRecordContactDm).toHaveBeenCalledWith("contact_1");
  });

  it("falls through to the default reply when the assistant declines", async () => {
    const processor = getProcessor();
    await processor(messageJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ defaultReplyEnabled: true }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage.mock.calls[0][3]).toContain(
      "Thanks for the message"
    );
  });

  it("releases the usage reservation when the assistant sends nothing", async () => {
    const processor = getProcessor();
    await processor(messageJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      new Date("2026-09-01T00:00:00.000Z")
    );
  });

  it("never lets an assistant failure cost a campaign its send", async () => {
    mockAnswerInboundMessage.mockRejectedValue(
      new Error("retrieval exploded mid-query")
    );

    const processor = getProcessor();
    await expect(processor(messageJob())).resolves.toBeUndefined();

    // The default-reply campaign still went out.
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage.mock.calls[0][3]).toContain(
      "Thanks for the message"
    );
  });

  it("survives a settings read that throws, and still sends the campaign", async () => {
    mockGetAnsweringSettings.mockRejectedValue(new Error("database down"));

    const processor = getProcessor();
    await expect(processor(messageJob())).resolves.toBeUndefined();

    expect(mockAnswerInboundMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("does not call the assistant at all when the workspace has it off", async () => {
    mockGetAnsweringSettings.mockResolvedValue({
      enabled: false,
      confidenceThreshold: 0.6,
      autoPauseMinutes: 30,
      disclosure: "",
    });

    const processor = getProcessor();
    await processor(messageJob());

    expect(mockAnswerInboundMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("does not try the assistant on a story mention", async () => {
    const processor = getProcessor();
    await processor(messageJob({ kind: "story_mention", messageText: "" }));

    expect(mockAnswerInboundMessage).not.toHaveBeenCalled();
  });

  it("does not try the assistant on a comment, where the private reply is one message ever", async () => {
    const processor = getProcessor();
    await processor({
      name: "process-comment",
      data: {
        instagramAccountId: "ig_456",
        commentId: "comment_1",
        commentText: "do you ship to ireland",
        commenterId: "igsid_customer",
        mediaId: "media_1",
      },
      id: "job_2",
      attemptsMade: 0,
      timestamp: Date.now(),
    });

    expect(mockAnswerInboundMessage).not.toHaveBeenCalled();
  });
});
