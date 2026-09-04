import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockQueueAdd,
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
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/contacts", () => ({
  upsertContact: vi.fn(async () => null),
  recordContactDm: vi.fn(),
}));

vi.mock("@/lib/ops/worker-health", () => ({ recordWorkerAlert: vi.fn() }));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__quickReplyWorkerProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }
  return { Worker: MockWorker };
});

// lib/meta/client is deliberately NOT mocked here: the point of these tests is
// the request Instagram actually receives, so the real sender runs against a
// stubbed fetch and the body is asserted.
import { sendDirectMessageWithQuickReplies } from "../lib/meta/client";
import {
  isRoutablePostbackPayload,
  parseQuickReplies,
  toMetaQuickReplies,
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_TITLE,
  type QuickReply,
} from "../lib/meta/quick-replies";
import { createDMWorker } from "../lib/queue/dm-worker";

function textReply(index: number, title = `Question ${index}`): QuickReply {
  return { title, type: "text", payload: `reveal:auto_${index}` };
}

function textReplies(count: number): QuickReply[] {
  return Array.from({ length: count }, (_, index) => textReply(index + 1));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastFetchBody(): Record<string, unknown> {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  const init = calls[calls.length - 1][1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("quick reply shaping", () => {
  it("accepts the maximum of thirteen buttons", () => {
    const shaped = toMetaQuickReplies(textReplies(MAX_QUICK_REPLIES));
    expect(shaped).toHaveLength(13);
  });

  it("refuses a fourteenth button rather than letting Meta reject the call", () => {
    expect(() => toMetaQuickReplies(textReplies(MAX_QUICK_REPLIES + 1))).toThrow(
      /at most 13/
    );
  });

  it("refuses an empty list", () => {
    expect(() => toMetaQuickReplies([])).toThrow(/at least one/);
  });

  it("truncates a title at twenty characters", () => {
    const shaped = toMetaQuickReplies([
      textReply(1, "How much does the whole thing cost"),
    ]);

    expect(shaped[0].title).toBe("How much does the wh");
    expect(shaped[0].title).toHaveLength(MAX_QUICK_REPLY_TITLE);
  });

  it("leaves a title of exactly twenty characters alone", () => {
    const title = "t".repeat(MAX_QUICK_REPLY_TITLE);
    expect(toMetaQuickReplies([textReply(1, title)])[0].title).toBe(title);
  });

  it("maps the prefilled types to Meta's content types and sends no title", () => {
    const shaped = toMetaQuickReplies([
      { title: "Email me", type: "email" },
      { title: "Call me", type: "phone" },
    ]);

    // Instagram fills these from the tapper's own profile, so a title of ours
    // would be ignored at best and rejected at worst.
    expect(shaped).toEqual([
      { content_type: "user_email" },
      { content_type: "user_phone_number" },
    ]);
  });
});

describe("reading quick replies off a campaign row", () => {
  it("returns nothing for a campaign that has none", () => {
    expect(parseQuickReplies(null)).toEqual([]);
    expect(parseQuickReplies(undefined)).toEqual([]);
    expect(parseQuickReplies({ title: "not an array" })).toEqual([]);
  });

  it("drops a text button with no payload, because the tap would say nothing", () => {
    expect(
      parseQuickReplies([
        { title: "Pricing", type: "text" },
        { title: "Hours", type: "text", payload: "reveal:auto_2" },
      ])
    ).toEqual([{ title: "Hours", type: "text", payload: "reveal:auto_2" }]);
  });

  it("drops entries in a shape we do not recognise", () => {
    expect(
      parseQuickReplies([
        { title: "Pricing", type: "carousel", payload: "x" },
        42,
        null,
        { title: "", type: "text", payload: "reveal:auto_1" },
      ])
    ).toEqual([]);
  });

  it("caps a hand-edited row at thirteen rather than failing the DM", () => {
    expect(parseQuickReplies(textReplies(20))).toHaveLength(MAX_QUICK_REPLIES);
  });
});

describe("routable payloads", () => {
  it("recognises the payloads the postback handler already acts on", () => {
    expect(isRoutablePostbackPayload("reveal:auto_1")).toBe(true);
    expect(isRoutablePostbackPayload("followcheck:auto_1")).toBe(true);
  });

  it("does not claim a bare keyword is routable", () => {
    expect(isRoutablePostbackPayload("PRICING")).toBe(false);
    expect(isRoutablePostbackPayload("")).toBe(false);
  });
});

describe("the send path", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ recipient_id: "user_1", message_id: "mid_1" })
    ) as unknown as typeof fetch;
  });

  it("puts quick replies on the message itself, titles already truncated", async () => {
    await sendDirectMessageWithQuickReplies(
      "token",
      "ig_456",
      "user_1",
      "What can I help with?",
      [
        { title: "How much is the programme", type: "text", payload: "reveal:a" },
        { title: "Email me the details", type: "email" },
      ]
    );

    const body = lastFetchBody();
    expect(body.recipient).toEqual({ id: "user_1" });
    expect(body.message).toEqual({
      text: "What can I help with?",
      quick_replies: [
        {
          content_type: "text",
          title: "How much is the prog",
          payload: "reveal:a",
        },
        { content_type: "user_email" },
      ],
    });
  });

  it("never reaches Meta with more than thirteen buttons", async () => {
    await expect(
      sendDirectMessageWithQuickReplies(
        "token",
        "ig_456",
        "user_1",
        "Pick one",
        textReplies(14)
      )
    ).rejects.toThrow(/at most 13/);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("surfaces a Meta rejection as a MetaApiError", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: "Invalid parameter", code: 100 } }, 400)
    ) as unknown as typeof fetch;

    await expect(
      sendDirectMessageWithQuickReplies("token", "ig_456", "user_1", "Hi", [
        textReply(1),
      ])
    ).rejects.toThrow("Invalid parameter");
  });
});

describe("the DM worker", () => {
  const automation = {
    id: "auto_789",
    workspaceId: "workspace_123",
    instagramAccountId: "ig_account_row_1",
    name: "FAQ",
    keywords: ["LINK"],
    dmMessage: "What can I help with?",
    linkButtonLabel: null,
    attachmentUrl: null,
    isActive: true,
    wholeWordMatch: true,
    matchAnyWord: false,
    requireFollow: false,
    followUpEnabled: false,
    followUpMessage: null,
    followUpDelayMinutes: 0,
    dmTriggerEnabled: true,
    quickRepliesEnabled: true,
    quickReplies: [
      { title: "How much does it cost", type: "text", payload: "reveal:auto_2" },
      { title: "Email me the details", type: "email" },
    ],
    instagramAccount: {
      id: "ig_account_row_1",
      instagramId: "ig_456",
      accessToken: "encrypted_token",
    },
    workspace: { id: "workspace_123" },
    trackedLinks: [],
  };

  function getProcessor(): (job: {
    name?: string;
    data: Record<string, unknown>;
    id: string;
    attemptsMade: number;
  }) => Promise<void> {
    createDMWorker();
    return (global as Record<string, unknown>)
      .__quickReplyWorkerProcessor as (job: {
      name?: string;
      data: Record<string, unknown>;
      id: string;
      attemptsMade: number;
    }) => Promise<void>;
  }

  function messageJob(data: Record<string, unknown> = {}) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_abc",
        messageText: "How much does it cost",
        senderId: "user_1",
        ...data,
      },
      id: "job_1",
      attemptsMade: 0,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ recipient_id: "user_1", message_id: "mid_1" })
    ) as unknown as typeof fetch;

    mockPrisma.automation.findMany.mockResolvedValue([automation]);
    mockPrisma.automation.findFirst.mockResolvedValue(automation);
    mockPrisma.dmLog.findUnique.mockResolvedValue(null);
    mockPrisma.dmLog.findFirst.mockResolvedValue({
      commenterName: "commenter_user",
    });
    mockPrisma.dmLog.upsert.mockResolvedValue({});
    mockPrisma.dmLog.update.mockResolvedValue({});
    mockPrisma.dmLog.create.mockResolvedValue({});
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_123",
    });
    mockDecryptToken.mockReturnValue("decrypted_token");
    mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: true,
      reserved: true,
      remaining: 100,
      limit: 2000,
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
    });
    mockReserveDMSlot.mockResolvedValue({
      allowed: true,
      shouldRequeue: false,
      shouldSkip: false,
      reserved: true,
      requeueDelayMs: 0,
    });
  });

  it("attaches a campaign's quick replies to its DM", async () => {
    const processor = getProcessor();
    await processor(messageJob());

    const body = lastFetchBody();
    expect(body.message).toEqual({
      text: "What can I help with?",
      quick_replies: [
        {
          content_type: "text",
          title: "How much does it cos",
          payload: "reveal:auto_2",
        },
        { content_type: "user_email" },
      ],
    });
  });

  it("sends a plain DM when the campaign has quick replies turned off", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...automation, quickRepliesEnabled: false },
    ]);

    const processor = getProcessor();
    await processor(messageJob());

    const body = lastFetchBody();
    expect(body.message).toEqual({ text: "What can I help with?" });
  });

  it("routes a quick reply tap into the existing postback handler", async () => {
    const processor = getProcessor();
    await processor(
      messageJob({
        messageText: "How much does it cost",
        quickReplyPayload: "reveal:auto_2",
      })
    );

    // The postback handler resolves the payload's campaign by id. The keyword
    // path is never entered, so there is no second delivery path to keep in
    // step with the follow gate, the usage reservation or the logging.
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "auto_2", isActive: true },
      })
    );
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
    expect(mockMatchKeywords).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("logs a quick reply tap the way a button tap is logged", async () => {
    const processor = getProcessor();
    await processor(messageJob({ quickReplyPayload: "reveal:auto_2" }));

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId_commentId: {
            automationId: "auto_789",
            commentId: "reveal:user_1",
          },
        },
      })
    );
  });

  it("leaves an unroutable payload to the ordinary keyword path", async () => {
    // Instagram posts the button's title to the conversation as a message, so a
    // payload we cannot resolve still gets an answer if a keyword matches.
    const processor = getProcessor();
    await processor(messageJob({ quickReplyPayload: "PRICING" }));

    expect(mockPrisma.automation.findMany).toHaveBeenCalled();
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
  });

  it("still answers an ordinary DM that carries no quick reply payload", async () => {
    const processor = getProcessor();
    await processor(messageJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalled();
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
  });

  it("keeps the link buttons when a campaign has both links and quick replies", async () => {
    // Instagram carries a button template or quick replies on one message, not
    // both. The tracked link is what the recipient asked for, so it wins.
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...automation,
        linkButtonLabel: "Get it",
        trackedLinks: [
          { slug: "abc123", label: "Get it", destinationUrl: "https://x.test" },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(messageJob());

    const body = lastFetchBody();
    const message = body.message as Record<string, unknown>;
    expect(message.quick_replies).toBeUndefined();
    expect(message.attachment).toBeDefined();
  });
});
