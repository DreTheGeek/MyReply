/**
 * Webhook route: what the four newly consumed fields actually do.
 *
 * The parsing rules live in webhook-fields.test.ts. These tests pin the
 * behaviour that costs money or truth if it is wrong: an echo of MyReply's own
 * DM must not be counted twice, an echo must not run automation, an edited
 * message must not earn a second DM, and an unreact must not be filed as
 * engagement.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockQueueAdd,
  mockUpsertContact,
  mockRecordOutboundMessageSeen,
  mockRecordContactReaction,
} = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: { create: vi.fn(), update: vi.fn() },
    operationalEvent: { create: vi.fn() },
    instagramAccount: { findUnique: vi.fn() },
    automation: { findFirst: vi.fn() },
    dmLog: { findFirst: vi.fn(), findMany: vi.fn() },
    outboundMessage: { findUnique: vi.fn(), create: vi.fn() },
  },
  mockQueueAdd: vi.fn(),
  mockUpsertContact: vi.fn(),
  mockRecordOutboundMessageSeen: vi.fn(),
  mockRecordContactReaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
}));

vi.mock("@/lib/contacts", () => ({
  upsertContact: mockUpsertContact,
  recordOutboundMessageSeen: mockRecordOutboundMessageSeen,
  recordContactReaction: mockRecordContactReaction,
}));

import { createHmac } from "crypto";
import { NextRequest } from "next/server";

import { POST } from "../app/api/webhook/route";

const SECRET = "test_app_secret_12345";
const ACCOUNT = "17841400000000000";
const USER = "1681657229596137";
const WORKSPACE = "ws_1";
const ACCOUNT_ROW_ID = "acct_db_1";

async function post(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature =
    "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

  return POST(
    new NextRequest("https://myreply.test/api/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body,
    })
  );
}

function echoPayload(message: Record<string, unknown>, timestamp = 1_760_000_000_000) {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: 1,
        messaging: [
          {
            sender: { id: ACCOUNT },
            recipient: { id: USER },
            timestamp,
            message: { is_echo: true, ...message },
          },
        ],
      },
    ],
  };
}

function inboundPayload(fields: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: 1,
        messaging: [
          { sender: { id: USER }, recipient: { id: ACCOUNT }, ...fields },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FACEBOOK_APP_SECRET", SECRET);

  mockPrisma.webhookEvent.create.mockResolvedValue({ id: "we_1" });
  mockPrisma.webhookEvent.update.mockResolvedValue({});
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    id: ACCOUNT_ROW_ID,
    workspaceId: WORKSPACE,
  });
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  mockPrisma.outboundMessage.findUnique.mockResolvedValue(null);
  mockPrisma.outboundMessage.create.mockResolvedValue({ id: "om_1" });
  mockQueueAdd.mockResolvedValue({});
  mockUpsertContact.mockResolvedValue({ id: "contact_1" });
});

describe("message_echoes", () => {
  it("records a reply a human typed in the Instagram app", async () => {
    const response = await post(
      echoPayload({ mid: "echo_1", text: "yep, sending it over" })
    );
    expect(response.status).toBe(200);

    expect(mockPrisma.outboundMessage.create).toHaveBeenCalledTimes(1);
    const created = mockPrisma.outboundMessage.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      workspaceId: WORKSPACE,
      instagramAccountId: ACCOUNT_ROW_ID,
      contactId: "contact_1",
      recipientId: USER,
      messageId: "echo_1",
      text: "yep, sending it over",
      source: "MANUAL",
      dmLogId: null,
    });
    expect(created.sentAt.getTime()).toBe(1_760_000_000_000);

    // Nobody else counted this one, so it is genuinely new outbound activity.
    expect(mockRecordOutboundMessageSeen).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "contact_1", countTowardsDmTotal: true })
    );
  });

  it("does not duplicate a DM MyReply just sent", async () => {
    // The send path already wrote this DmLog row and already moved the
    // contact's DM counter. The echo is the same message coming back.
    mockPrisma.dmLog.findFirst.mockResolvedValue({ id: "dmlog_1" });

    await post(echoPayload({ mid: "echo_2", text: "here is your link" }));

    expect(mockPrisma.outboundMessage.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.outboundMessage.create.mock.calls[0][0].data).toMatchObject({
      source: "AUTOMATION",
      dmLogId: "dmlog_1",
    });
    expect(mockRecordOutboundMessageSeen).toHaveBeenCalledWith(
      expect.objectContaining({ countTowardsDmTotal: false })
    );
  });

  it("writes nothing on a redelivery of an echo it already recorded", async () => {
    mockPrisma.outboundMessage.findUnique.mockResolvedValue({ id: "om_existing" });

    await post(echoPayload({ mid: "echo_3", text: "already stored" }));

    expect(mockPrisma.outboundMessage.create).not.toHaveBeenCalled();
    expect(mockRecordOutboundMessageSeen).not.toHaveBeenCalled();
  });

  it("never re-triggers automation from an echo", async () => {
    // The echoed text carries a keyword on purpose. If this enqueued anything,
    // an autoreply could answer itself.
    await post(echoPayload({ mid: "echo_4", text: "LINK" }));

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("message_edit", () => {
  it("re-evaluates the corrected text against campaigns", async () => {
    await post(
      inboundPayload({
        message_edit: { mid: "m_9", text: "LINK", num_edit: 1 },
      })
    );

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOptions] = mockQueueAdd.mock.calls[0];
    expect(jobName).toBe("process-message");
    expect(jobData).toMatchObject({
      instagramAccountId: ACCOUNT,
      messageId: "m_9",
      messageText: "LINK",
      senderId: USER,
      kind: "dm",
    });

    // The original message's job id is already in BullMQ. Reusing it would let
    // BullMQ drop the correction as a duplicate job and lose it silently.
    const originalJobId = `message_${ACCOUNT}_${Buffer.from("m_9").toString(
      "base64url"
    )}`;
    expect(jobOptions.jobId).not.toBe(originalJobId);
    expect(jobOptions.jobId).toContain("_1");
  });

  it("gives each successive correction its own job, and dedupes a redelivery", async () => {
    await post(
      inboundPayload({ message_edit: { mid: "m_9", text: "LINK", num_edit: 1 } })
    );
    await post(
      inboundPayload({ message_edit: { mid: "m_9", text: "LINKS", num_edit: 2 } })
    );
    await post(
      inboundPayload({ message_edit: { mid: "m_9", text: "LINKS", num_edit: 2 } })
    );

    const jobIds = mockQueueAdd.mock.calls.map((call) => call[2].jobId);
    expect(jobIds[0]).not.toBe(jobIds[1]);
    // A redelivery of the same correction lands on the same job id, which is
    // what makes BullMQ collapse it rather than sending twice.
    expect(jobIds[2]).toBe(jobIds[1]);
  });

  it("does not send a second DM for a message that was already answered", async () => {
    // A DmLog row keyed `dm:<mid>` with status SENT means this message has
    // already earned its reply. Editing it must not earn another.
    mockPrisma.dmLog.findFirst.mockResolvedValue({ id: "dmlog_sent" });

    await post(
      inboundPayload({ message_edit: { mid: "m_9", text: "LINK", num_edit: 1 } })
    );

    expect(mockPrisma.dmLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          commentId: "dm:m_9",
          status: "SENT",
        }),
      })
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("message_reactions", () => {
  it("records a react against the contact", async () => {
    await post(
      inboundPayload({
        reaction: { mid: "m_20", action: "react", reaction: "love", emoji: "❤️" },
      })
    );

    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: USER, workspaceId: WORKSPACE })
    );
    expect(mockRecordContactReaction).toHaveBeenCalledWith(
      "contact_1",
      expect.any(Date)
    );
  });

  it("does not record an unreact as a positive signal", async () => {
    await post(
      inboundPayload({ reaction: { mid: "m_21", action: "unreact" } })
    );

    expect(mockRecordContactReaction).not.toHaveBeenCalled();
  });
});

describe("mentions", () => {
  it("surfaces a caption mention delivered on the dedicated field", async () => {
    await post({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          changes: [{ field: "mentions", value: { media_id: "media_1" } }],
        },
      ],
    });

    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
    const event = mockPrisma.operationalEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({
      workspaceId: WORKSPACE,
      source: "SYSTEM",
      level: "INFO",
      message: "Instagram caption mention received",
    });
    expect(event.payload).toMatchObject({
      mediaId: "media_1",
      commentId: null,
      surface: "caption",
      deliveredOn: "mentions",
    });
  });

  it("surfaces the same mention when Meta folds it into comments", async () => {
    await post({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          changes: [
            {
              field: "comments",
              value: {
                item: "mention",
                id: "comment_2",
                media: { id: "media_3" },
                from: { id: "9999", username: "someone" },
              },
            },
          ],
        },
      ],
    });

    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
    expect(
      mockPrisma.operationalEvent.create.mock.calls[0][0].data.payload
    ).toMatchObject({
      mediaId: "media_3",
      commentId: "comment_2",
      mentionerId: "9999",
      surface: "comment",
      deliveredOn: "comments",
    });

    // Not also handled as a comment on our own media, and never wired to a DM.
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("does not send a DM for a mention", async () => {
    await post({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          changes: [
            {
              field: "mentions",
              value: { comment_id: "comment_1", media_id: "media_2" },
            },
          ],
        },
      ],
    });

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
