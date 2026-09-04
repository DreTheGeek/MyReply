import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Answering tests.
 *
 * Every provider call is a stubbed fetch. Nothing in this file touches the
 * network, a database or Redis: prisma, the credential store and the queue
 * client are all mocked at the module boundary.
 */

const { mockPrisma, mockGetCredential, mockTouchKey, mockRedisSet } = vi.hoisted(
  () => ({
    mockPrisma: {
      knowledgeChunk: { findMany: vi.fn() },
      knowledgeSource: { count: vi.fn(), create: vi.fn() },
      assistantAnswer: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
      outboundMessage: { count: vi.fn() },
      operationalEvent: { findFirst: vi.fn(), create: vi.fn() },
    },
    mockGetCredential: vi.fn(),
    mockTouchKey: vi.fn(),
    mockRedisSet: vi.fn(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/ai/workspace-key", () => ({
  getWorkspaceAiCredential: mockGetCredential,
  touchWorkspaceAiKey: mockTouchKey,
}));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({ set: mockRedisSet }),
}));

import {
  ANSWER_DEADLINE_MS,
  answerInboundMessage,
  computeConfidence,
  generateAnswer,
  isWithinMessagingWindow,
  MESSAGING_WINDOW_MS,
  UNCITED_PENALTY,
} from "@/lib/ai/answering";
import {
  DEFAULT_ANSWERING_SETTINGS,
  getAnsweringSettings,
  isPausedByHuman,
  saveAnsweringSettings,
  type AnsweringSettings,
} from "@/lib/ai/answering-settings";
import {
  buildCorrectionChunk,
  listAssistantAnswers,
  reviewAssistantAnswer,
} from "@/lib/ai/answer-review";
import {
  groundedness,
  queryTerms,
  rankCandidates,
  retrieveForQuestion,
} from "@/lib/ai/retrieval";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = new Date("2026-09-04T12:00:00.000Z");

function chunkRow(id: string, content: string, title = "Shipping policy") {
  return {
    id,
    content,
    citation: null,
    source: { id: `src_${id}`, title },
  };
}

const SHIPPING_CHUNK = chunkRow(
  "chunk_1",
  "Standard shipping to the United Kingdom takes 3 working days and costs 4 pounds. Orders over 50 pounds ship free."
);

const RETURNS_CHUNK = chunkRow(
  "chunk_2",
  "Returns are accepted within 30 days of delivery. The customer pays return postage unless the item arrived damaged.",
  "Returns policy"
);

/**
 * One provider response, shaped as Anthropic's Messages API returns it, so the
 * real parser in lib/ai/client does the work.
 */
function anthropicToolReply(input: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "reply_to_customer",
          input,
        },
      ],
      stop_reason: "tool_use",
    }),
  } as unknown as Response;
}

function fetchReturning(response: Response) {
  return vi.fn(async (_url: string, _init: RequestInit) => response);
}

function settings(overrides: Partial<AnsweringSettings> = {}): AnsweringSettings {
  return { ...DEFAULT_ANSWERING_SETTINGS, enabled: true, ...overrides };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_1",
    workspaceName: "Acme",
    instagramAccountId: "iga_1",
    contactId: "contact_1",
    recipientId: "igsid_1",
    messageId: "mid_1",
    question: "How long does shipping to the UK take and what does it cost?",
    customerMessageAt: new Date(NOW.getTime() - 60_000),
    now: NOW,
    settings: settings(),
    claim: vi.fn(async () => true),
    send: vi.fn(async (_text: string) => {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockPrisma.knowledgeSource.count.mockResolvedValue(2);
  mockPrisma.knowledgeChunk.findMany.mockResolvedValue([
    SHIPPING_CHUNK,
    RETURNS_CHUNK,
  ]);
  mockPrisma.outboundMessage.count.mockResolvedValue(0);
  mockPrisma.assistantAnswer.create.mockResolvedValue({ id: "ans_1" });
  mockPrisma.operationalEvent.findFirst.mockResolvedValue(null);
  mockGetCredential.mockResolvedValue({
    provider: "ANTHROPIC",
    model: "claude-opus-5",
    apiKey: "sk-ant-test-key-value-1234567890",
  });
  mockRedisSet.mockResolvedValue("OK");
});

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                  */
/* -------------------------------------------------------------------------- */

describe("retrieval", () => {
  it("drops stop words and keeps digits, because numbers are what gets invented", () => {
    expect(queryTerms("How much is the 30 day return?")).toEqual([
      "much",
      "30",
      "day",
      "return",
    ]);
  });

  it("ranks the chunk that shares the rare terms above the one that does not", () => {
    const result = rankCandidates("how long is shipping to the united kingdom", [
      SHIPPING_CHUNK,
      RETURNS_CHUNK,
    ]);

    expect(result.chunks[0].chunkId).toBe("chunk_1");
    expect(result.coverage).toBeGreaterThan(0.5);
  });

  it("scores a substring-only candidate out of the context entirely", () => {
    // "car" is a substring of "carpet" but not a word in it, so the recall
    // query would return this row and scoring has to reject it.
    const result = rankCandidates("car", [chunkRow("chunk_9", "We sell carpet.")]);

    expect(result.chunks).toHaveLength(0);
    expect(result.coverage).toBe(0);
  });

  it("gives a question the knowledge base never mentions a low coverage", () => {
    const result = rankCandidates("do you offer gift wrapping and engraving", [
      SHIPPING_CHUNK,
      RETURNS_CHUNK,
    ]);

    expect(result.coverage).toBeLessThan(0.35);
  });

  it("only searches READY sources in the workspace", async () => {
    await retrieveForQuestion("ws_1", "shipping cost");

    const call = mockPrisma.knowledgeChunk.findMany.mock.calls[0][0];
    expect(call.where.source).toEqual({ workspaceId: "ws_1", status: "READY" });
  });

  it("does not query at all for a question with no content terms", async () => {
    const result = await retrieveForQuestion("ws_1", "the and it");

    expect(mockPrisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(result.chunks).toHaveLength(0);
  });

  it("scores an answer that invents a number below one that does not", () => {
    const chunks = rankCandidates("shipping uk", [SHIPPING_CHUNK]).chunks;

    const supported = groundedness("Standard shipping takes 3 working days.", chunks);
    const invented = groundedness(
      "Express shipping arrives tomorrow for 9 dollars via courier.",
      chunks
    );

    expect(supported).toBeGreaterThan(invented);
  });

  it("treats an answer with no content terms as fully grounded", () => {
    // Nothing was asserted that could be unsupported, so there is nothing to
    // hold against it. Coverage still has to carry the score on its own.
    expect(groundedness("We do.", [])).toBe(1);
    // "yes" is a content term, so a bare yes is not a free pass.
    expect(groundedness("Yes, we do.", [])).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Confidence                                                                 */
/* -------------------------------------------------------------------------- */

describe("confidence", () => {
  it("is the geometric mean, so one weak half cannot be averaged away", () => {
    expect(computeConfidence({ coverage: 0.9, groundedness: 0.2, cited: true })).toBe(
      Math.round(Math.sqrt(0.18) * 1000) / 1000
    );
    // The arithmetic mean would have been 0.55 and would have cleared the
    // default threshold. This does not.
    expect(
      computeConfidence({ coverage: 0.9, groundedness: 0.2, cited: true })
    ).toBeLessThan(DEFAULT_ANSWERING_SETTINGS.confidenceThreshold);
  });

  it("collapses to zero when either half is zero", () => {
    expect(computeConfidence({ coverage: 0, groundedness: 1, cited: true })).toBe(0);
    expect(computeConfidence({ coverage: 1, groundedness: 0, cited: true })).toBe(0);
  });

  it("halves an uncited answer", () => {
    const cited = computeConfidence({ coverage: 1, groundedness: 1, cited: true });
    const uncited = computeConfidence({ coverage: 1, groundedness: 1, cited: false });

    expect(cited).toBe(1);
    expect(uncited).toBe(UNCITED_PENALTY);
  });

  it("never leaves 0 to 1, whatever it is handed", () => {
    expect(computeConfidence({ coverage: 9, groundedness: 9, cited: true })).toBe(1);
    expect(computeConfidence({ coverage: -1, groundedness: 1, cited: true })).toBe(0);
    expect(computeConfidence({ coverage: NaN, groundedness: 1, cited: true })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

describe("generateAnswer", () => {
  it("sends exactly one tool, because an empty tools array is rejected upstream", async () => {
    const doFetch = fetchReturning(
      anthropicToolReply({
        can_answer: true,
        answer: "Standard shipping to the United Kingdom takes 3 working days.",
        sources: ["chunk_1"],
      })
    );

    const retrieval = rankCandidates("shipping uk", [SHIPPING_CHUNK]);
    await generateAnswer({
      workspaceName: "Acme",
      question: "shipping uk",
      retrieval,
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: "sk-ant-key-1234567890123456",
      fetchImpl: doFetch,
    });

    const body = JSON.parse(String(doFetch.mock.calls[0][1].body));
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("reply_to_customer");
  });

  it("returns a null answer when the model declines", async () => {
    const retrieval = rankCandidates("shipping uk", [SHIPPING_CHUNK]);

    const result = await generateAnswer({
      workspaceName: "Acme",
      question: "shipping uk",
      retrieval,
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: "sk-ant-key-1234567890123456",
      fetchImpl: fetchReturning(
        anthropicToolReply({ can_answer: false, answer: "", sources: [] })
      ),
    });

    expect(result.answer).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("drops a cited chunk id that was never in the context", async () => {
    const retrieval = rankCandidates("shipping uk", [SHIPPING_CHUNK]);

    const result = await generateAnswer({
      workspaceName: "Acme",
      question: "shipping uk",
      retrieval,
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: "sk-ant-key-1234567890123456",
      fetchImpl: fetchReturning(
        anthropicToolReply({
          can_answer: true,
          answer: "Shipping takes 3 working days.",
          sources: ["chunk_1", "chunk_does_not_exist"],
        })
      ),
    });

    expect(result.citedChunkIds).toEqual(["chunk_1"]);
  });

  it("gives up on the provider at the deadline rather than answering late", async () => {
    const retrieval = rankCandidates("shipping uk", [SHIPPING_CHUNK]);
    const hanging = vi.fn(
      () => new Promise<Response>(() => {})
    ) as unknown as typeof fetch;

    await expect(
      generateAnswer({
        workspaceName: "Acme",
        question: "shipping uk",
        retrieval,
        provider: "ANTHROPIC",
        model: "claude-opus-5",
        apiKey: "sk-ant-key-1234567890123456",
        fetchImpl: hanging as never,
        deadlineMs: 10,
      })
    ).rejects.toThrow(/did not answer in time/);

    // The real deadline sits well inside Meta's 30 second rule.
    expect(ANSWER_DEADLINE_MS).toBeLessThan(30_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Policy refusals                                                            */
/* -------------------------------------------------------------------------- */

describe("answerInboundMessage refuses", () => {
  it("never answers outside Meta's 24 hour window", async () => {
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(
      baseInput({
        customerMessageAt: new Date(NOW.getTime() - MESSAGING_WINDOW_MS - 1000),
        send,
        fetchImpl: fetchReturning(
          anthropicToolReply({ can_answer: true, answer: "Hi", sources: ["chunk_1"] })
        ),
      }) as never
    );

    expect(outcome).toEqual({ status: "declined", reason: "window_closed" });
    expect(send).not.toHaveBeenCalled();
    expect(mockGetCredential).not.toHaveBeenCalled();
    expect(mockPrisma.assistantAnswer.create).not.toHaveBeenCalled();
  });

  it("treats the boundary as closed and one second inside it as open", () => {
    const exactlyAtLimit = new Date(NOW.getTime() - MESSAGING_WINDOW_MS);
    const justInside = new Date(NOW.getTime() - MESSAGING_WINDOW_MS + 1000);

    expect(isWithinMessagingWindow(exactlyAtLimit, NOW)).toBe(false);
    expect(isWithinMessagingWindow(justInside, NOW)).toBe(true);
  });

  it("never answers when the workspace has no knowledge sources", async () => {
    mockPrisma.knowledgeSource.count.mockResolvedValue(0);
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(baseInput({ send }) as never);

    expect(outcome).toEqual({ status: "declined", reason: "no_knowledge" });
    expect(send).not.toHaveBeenCalled();
    expect(mockPrisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
  });

  it("never answers when retrieval finds nothing for the question", async () => {
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([]);
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(baseInput({ send }) as never);

    expect(outcome).toEqual({ status: "declined", reason: "no_retrieval" });
    expect(send).not.toHaveBeenCalled();
  });

  it("stays quiet while a human is handling the conversation", async () => {
    mockPrisma.outboundMessage.count.mockResolvedValue(1);
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(baseInput({ send }) as never);

    expect(outcome).toEqual({ status: "declined", reason: "paused_by_human" });
    expect(send).not.toHaveBeenCalled();
    expect(mockGetCredential).not.toHaveBeenCalled();
  });

  it("does not answer the same message twice", async () => {
    const claim = vi.fn(async () => false);
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(
      baseInput({ claim, send }) as never
    );

    expect(outcome).toEqual({ status: "declined", reason: "already_answered" });
    expect(send).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledWith("assistant:answered:mid_1");
  });

  it("stays off until the workspace turns it on", async () => {
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(
      baseInput({ settings: settings({ enabled: false }), send }) as never
    );

    expect(outcome).toEqual({ status: "declined", reason: "disabled" });
    expect(send).not.toHaveBeenCalled();
  });

  it("declines when the workspace has no provider key", async () => {
    mockGetCredential.mockResolvedValue(null);
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(baseInput({ send }) as never);

    expect(outcome).toEqual({ status: "declined", reason: "no_ai_key" });
    expect(send).not.toHaveBeenCalled();
  });

  it("declines a provider failure rather than sending anything", async () => {
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(
      baseInput({
        send,
        fetchImpl: vi.fn(async () => ({
          ok: false,
          status: 401,
          json: async () => ({ error: { message: "invalid key" } }),
        })) as never,
      }) as never
    );

    expect(outcome).toEqual({ status: "declined", reason: "provider_error" });
    expect(send).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Threshold and handoff                                                      */
/* -------------------------------------------------------------------------- */

describe("answerInboundMessage threshold", () => {
  it("sends a well supported answer and records it as not handed off", async () => {
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(
      baseInput({
        send,
        settings: settings({ disclosure: "" }),
        fetchImpl: fetchReturning(
          anthropicToolReply({
            can_answer: true,
            answer:
              "Standard shipping to the United Kingdom takes 3 working days and costs 4 pounds.",
            sources: ["chunk_1"],
          })
        ),
      }) as never
    );

    expect(outcome.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);

    const written = mockPrisma.assistantAnswer.create.mock.calls[0][0].data;
    expect(written.handedOff).toBe(false);
    expect(written.workspaceId).toBe("ws_1");
    expect(written.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("appends the disclosure to what is sent but not to what is stored", async () => {
    const send = vi.fn(async (_text: string) => {});

    await answerInboundMessage(
      baseInput({
        send,
        settings: settings({ disclosure: "Sent by an assistant." }),
        fetchImpl: fetchReturning(
          anthropicToolReply({
            can_answer: true,
            answer:
              "Standard shipping to the United Kingdom takes 3 working days and costs 4 pounds.",
            sources: ["chunk_1"],
          })
        ),
      }) as never
    );

    expect(send.mock.calls[0][0]).toContain("Sent by an assistant.");
    expect(
      mockPrisma.assistantAnswer.create.mock.calls[0][0].data.answer
    ).not.toContain("Sent by an assistant.");
  });

  it("hands off below the threshold and sends nothing", async () => {
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(
      baseInput({
        send,
        settings: settings({ confidenceThreshold: 0.99 }),
        fetchImpl: fetchReturning(
          anthropicToolReply({
            can_answer: true,
            answer: "Standard shipping takes 3 working days.",
            sources: ["chunk_1"],
          })
        ),
      }) as never
    );

    expect(outcome.status).toBe("handed_off");
    expect(send).not.toHaveBeenCalled();
    expect(mockPrisma.assistantAnswer.create.mock.calls[0][0].data.handedOff).toBe(
      true
    );
  });

  it("hands off when the model says it does not know", async () => {
    const send = vi.fn(async (_text: string) => {});

    const outcome = await answerInboundMessage(
      baseInput({
        send,
        fetchImpl: fetchReturning(
          anthropicToolReply({ can_answer: false, answer: "", sources: [] })
        ),
      }) as never
    );

    expect(outcome).toMatchObject({ status: "handed_off", reason: "model_declined" });
    expect(send).not.toHaveBeenCalled();
    expect(mockPrisma.assistantAnswer.create.mock.calls[0][0].data.handedOff).toBe(
      true
    );
  });

  it("records a handoff when the send itself fails, instead of losing the answer", async () => {
    const send = vi.fn(async (_text: string) => {
      throw new Error("Meta said no");
    });

    const outcome = await answerInboundMessage(
      baseInput({
        send,
        settings: settings({ disclosure: "" }),
        fetchImpl: fetchReturning(
          anthropicToolReply({
            can_answer: true,
            answer:
              "Standard shipping to the United Kingdom takes 3 working days and costs 4 pounds.",
            sources: ["chunk_1"],
          })
        ),
      }) as never
    );

    expect(outcome).toMatchObject({ status: "handed_off", reason: "send_failed" });
    expect(mockPrisma.assistantAnswer.create.mock.calls[0][0].data.handedOff).toBe(
      true
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Settings and auto-pause                                                    */
/* -------------------------------------------------------------------------- */

describe("answering settings", () => {
  it("defaults to off, so answering is opt in", async () => {
    mockPrisma.operationalEvent.findFirst.mockResolvedValue(null);

    const result = await getAnsweringSettings("ws_1");

    expect(result).toEqual(DEFAULT_ANSWERING_SETTINGS);
    expect(result.enabled).toBe(false);
  });

  it("reads the newest journal row and fills gaps from the defaults", async () => {
    mockPrisma.operationalEvent.findFirst.mockResolvedValue({
      payload: { enabled: true, confidenceThreshold: 0.8 },
    });

    const result = await getAnsweringSettings("ws_1");

    expect(result.enabled).toBe(true);
    expect(result.confidenceThreshold).toBe(0.8);
    expect(result.autoPauseMinutes).toBe(
      DEFAULT_ANSWERING_SETTINGS.autoPauseMinutes
    );

    const call = mockPrisma.operationalEvent.findFirst.mock.calls[0][0];
    expect(call.orderBy).toEqual({ createdAt: "desc" });
    expect(call.where.message).toBe("assistant.answering.settings");
  });

  it("falls back to the safe defaults when a stored row is malformed", async () => {
    mockPrisma.operationalEvent.findFirst.mockResolvedValue({
      payload: { enabled: "yes", confidenceThreshold: 42 },
    });

    expect(await getAnsweringSettings("ws_1")).toEqual(DEFAULT_ANSWERING_SETTINGS);
  });

  it("writes settings changes resolved, so they stay out of the issues feed", async () => {
    mockPrisma.operationalEvent.create.mockResolvedValue({ id: "ev_1" });

    await saveAnsweringSettings({
      workspaceId: "ws_1",
      settings: settings({ confidenceThreshold: 0.75 }),
      updatedByUserId: "user_1",
    });

    const data = mockPrisma.operationalEvent.create.mock.calls[0][0].data;
    expect(data.resolvedAt).toBeInstanceOf(Date);
    expect(data.source).toBe("SYSTEM");
    expect(data.payload.updatedByUserId).toBe("user_1");
  });

  it("pauses on a human reply and ignores our own automated one", async () => {
    mockPrisma.outboundMessage.count.mockResolvedValue(1);

    const paused = await isPausedByHuman({
      instagramAccountId: "iga_1",
      recipientId: "igsid_1",
      autoPauseMinutes: 30,
      now: NOW,
    });

    expect(paused).toBe(true);
    const where = mockPrisma.outboundMessage.count.mock.calls[0][0].where;
    expect(where.source).toBe("MANUAL");
    expect(where.sentAt.gte).toEqual(new Date(NOW.getTime() - 30 * 60_000));
  });

  it("does not query at all when the pause window is off", async () => {
    const paused = await isPausedByHuman({
      instagramAccountId: "iga_1",
      recipientId: "igsid_1",
      autoPauseMinutes: 0,
      now: NOW,
    });

    expect(paused).toBe(false);
    expect(mockPrisma.outboundMessage.count).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The correction loop                                                        */
/* -------------------------------------------------------------------------- */

describe("the correction loop", () => {
  beforeEach(() => {
    mockPrisma.assistantAnswer.findFirst.mockResolvedValue({
      id: "ans_1",
      question: "Do you ship to Ireland?",
    });
    mockPrisma.assistantAnswer.update.mockResolvedValue({ id: "ans_1" });
    mockPrisma.knowledgeSource.create.mockResolvedValue({ id: "ks_1" });
  });

  it("turns a WRONG verdict into a MANUAL source with a chunk", async () => {
    const result = await reviewAssistantAnswer({
      workspaceId: "ws_1",
      answerId: "ans_1",
      verdict: "WRONG",
      correction: "We ship to Ireland in 5 working days for 8 pounds.",
    });

    expect(result).toEqual({
      ok: true,
      verdict: "WRONG",
      knowledgeSourceId: "ks_1",
    });

    const data = mockPrisma.knowledgeSource.create.mock.calls[0][0].data;
    expect(data.kind).toBe("MANUAL");
    expect(data.workspaceId).toBe("ws_1");
    // READY, or it would not be retrievable and the loop would not close.
    expect(data.status).toBe("READY");
    // The original question is in the chunk, which is what makes the correction
    // rank for the phrasing that got it wrong.
    expect(data.chunks.create.content).toContain("Do you ship to Ireland?");
    expect(data.chunks.create.content).toContain("5 working days");
  });

  it("refuses a WRONG with nothing to learn from", async () => {
    const result = await reviewAssistantAnswer({
      workspaceId: "ws_1",
      answerId: "ans_1",
      verdict: "WRONG",
      correction: "   ",
    });

    expect(result).toEqual({ ok: false, error: "correction_required" });
    expect(mockPrisma.assistantAnswer.update).not.toHaveBeenCalled();
    expect(mockPrisma.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it("records GOOD without writing to the knowledge base", async () => {
    const result = await reviewAssistantAnswer({
      workspaceId: "ws_1",
      answerId: "ans_1",
      verdict: "GOOD",
    });

    expect(result).toEqual({ ok: true, verdict: "GOOD", knowledgeSourceId: null });
    expect(mockPrisma.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it("cannot review an answer belonging to another workspace", async () => {
    mockPrisma.assistantAnswer.findFirst.mockResolvedValue(null);

    const result = await reviewAssistantAnswer({
      workspaceId: "ws_other",
      answerId: "ans_1",
      verdict: "GOOD",
    });

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(mockPrisma.assistantAnswer.update).not.toHaveBeenCalled();
  });

  it("makes a correction retrievable for the question that failed", () => {
    const content = buildCorrectionChunk(
      "Do you ship to Ireland?",
      "We ship to Ireland in 5 working days."
    );

    const ranked = rankCandidates("do you ship to ireland", [
      chunkRow("chunk_fix", content, "Correction"),
      SHIPPING_CHUNK,
    ]);

    expect(ranked.chunks[0].chunkId).toBe("chunk_fix");
  });

  it("lists the queue newest first and filters to unreviewed", async () => {
    mockPrisma.assistantAnswer.findMany.mockResolvedValue([
      {
        id: "ans_1",
        question: "shipping to the uk",
        answer: "Three working days.",
        confidence: 0.72,
        handedOff: false,
        verdict: null,
        correction: null,
        createdAt: NOW,
        contact: { id: "contact_1", username: "buyer", name: null },
      },
    ]);
    mockPrisma.assistantAnswer.count.mockResolvedValue(1);

    const result = await listAssistantAnswers({
      workspaceId: "ws_1",
      unreviewedOnly: true,
    });

    expect(result.answers).toHaveLength(1);
    expect(result.unreviewedCount).toBe(1);
    expect(result.answers[0].sources.length).toBeGreaterThan(0);

    const call = mockPrisma.assistantAnswer.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "ws_1", verdict: null });
    expect(call.orderBy).toEqual({ createdAt: "desc" });
  });
});
