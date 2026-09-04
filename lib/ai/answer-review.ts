/**
 * The correction loop.
 *
 * An answer nobody looks at is a liability, and a correction that only lands in
 * a text field is a note to nobody. So a WRONG verdict does two things: it
 * records the human's version, and it writes that version back into the
 * knowledge base as a MANUAL KnowledgeSource with a chunk, which is the same
 * store retrieval reads. The next time the question is asked, the corrected
 * answer is a candidate with the customer's own words in it, so it ranks for
 * the phrasing that got it wrong the first time.
 *
 * The chunk carries the original question verbatim, for two reasons. It is the
 * citation a reviewer needs to understand why this passage exists. And it is
 * what makes retrieval work: BM25 matches the terms a customer actually used,
 * and those live in the question, not in the polished answer.
 *
 * Sources shown alongside an answer are reconstructed by re-running retrieval
 * on the stored question, because the schema keeps no chunk list on
 * AssistantAnswer. That is a reconstruction, not a record: if the knowledge base
 * changed since, this shows what the question retrieves now. For a reviewer
 * about to correct something, "what would it answer from today" is the more
 * useful of the two, and it is labelled as such in the UI.
 */

import type { AnswerVerdict } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { retrieveForQuestion } from "@/lib/ai/retrieval";

export const MAX_CORRECTION_CHARS = 2000;

/** One page of the review queue. Small on purpose: each row re-runs retrieval. */
export const MAX_ANSWER_PAGE_SIZE = 25;
export const DEFAULT_ANSWER_PAGE_SIZE = 20;

export interface AnswerSourceSummary {
  chunkId: string;
  sourceTitle: string;
  citation: string | null;
  /** Trimmed for display. The full passage lives in the knowledge base. */
  excerpt: string;
}

export interface AssistantAnswerSummary {
  id: string;
  question: string;
  answer: string;
  confidence: number;
  handedOff: boolean;
  verdict: AnswerVerdict | null;
  correction: string | null;
  createdAt: string;
  contact: { id: string; username: string | null; name: string | null } | null;
  sources: AnswerSourceSummary[];
}

export interface ListAnswersFilter {
  workspaceId: string;
  /** Only answers no human has ruled on yet. */
  unreviewedOnly?: boolean;
  /** Only answers that were not sent and are waiting for a person. */
  handedOffOnly?: boolean;
  limit?: number;
  /** Cursor is the id of the last row of the previous page. */
  cursor?: string | null;
}

export interface ListAnswersResult {
  answers: AssistantAnswerSummary[];
  nextCursor: string | null;
  /** Unreviewed count for the whole workspace, for the queue badge. */
  unreviewedCount: number;
}

const EXCERPT_CHARS = 240;

export async function listAssistantAnswers(
  filter: ListAnswersFilter
): Promise<ListAnswersResult> {
  const take = Math.min(
    Math.max(filter.limit ?? DEFAULT_ANSWER_PAGE_SIZE, 1),
    MAX_ANSWER_PAGE_SIZE
  );

  const where = {
    workspaceId: filter.workspaceId,
    ...(filter.unreviewedOnly ? { verdict: null } : {}),
    ...(filter.handedOffOnly ? { handedOff: true } : {}),
  };

  const [rows, unreviewedCount] = await Promise.all([
    prisma.assistantAnswer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        question: true,
        answer: true,
        confidence: true,
        handedOff: true,
        verdict: true,
        correction: true,
        createdAt: true,
        contact: { select: { id: true, username: true, name: true } },
      },
    }),
    prisma.assistantAnswer.count({
      where: { workspaceId: filter.workspaceId, verdict: null },
    }),
  ]);

  const page = rows.slice(0, take);
  const nextCursor = rows.length > take ? page[page.length - 1].id : null;

  const answers = await Promise.all(
    page.map(async (row): Promise<AssistantAnswerSummary> => {
      const retrieval = await retrieveForQuestion(
        filter.workspaceId,
        row.question
      );

      return {
        id: row.id,
        question: row.question,
        answer: row.answer,
        confidence: row.confidence,
        handedOff: row.handedOff,
        verdict: row.verdict,
        correction: row.correction,
        createdAt: row.createdAt.toISOString(),
        contact: row.contact,
        sources: retrieval.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          sourceTitle: chunk.sourceTitle,
          citation: chunk.citation,
          excerpt:
            chunk.content.length > EXCERPT_CHARS
              ? `${chunk.content.slice(0, EXCERPT_CHARS)}...`
              : chunk.content,
        })),
      };
    })
  );

  return { answers, nextCursor, unreviewedCount };
}

export interface ReviewAnswerInput {
  workspaceId: string;
  answerId: string;
  verdict: AnswerVerdict;
  /** Required for WRONG. This is what feeds back into the knowledge base. */
  correction?: string | null;
}

export type ReviewAnswerResult =
  | { ok: false; error: "not_found" }
  | { ok: false; error: "correction_required" }
  | {
      ok: true;
      verdict: AnswerVerdict;
      /** Set when a correction was written back as a new MANUAL source. */
      knowledgeSourceId: string | null;
    };

/**
 * Record a verdict, and for WRONG turn the correction into knowledge.
 *
 * The read is scoped to the workspace before anything is written, so an id
 * guessed from another tenant finds nothing rather than being reviewed.
 */
export async function reviewAssistantAnswer(
  input: ReviewAnswerInput
): Promise<ReviewAnswerResult> {
  const answer = await prisma.assistantAnswer.findFirst({
    where: { id: input.answerId, workspaceId: input.workspaceId },
    select: { id: true, question: true },
  });
  if (!answer) return { ok: false, error: "not_found" };

  const correction = input.correction?.trim() ?? "";

  if (input.verdict === "WRONG" && !correction) {
    // A WRONG with nothing to learn from is the one review that leaves the
    // product worse than before: the same question would get the same answer.
    return { ok: false, error: "correction_required" };
  }

  await prisma.assistantAnswer.update({
    where: { id: answer.id },
    data: {
      verdict: input.verdict,
      correction: input.verdict === "WRONG" ? correction : null,
    },
  });

  if (input.verdict !== "WRONG") {
    return { ok: true, verdict: input.verdict, knowledgeSourceId: null };
  }

  const source = await prisma.knowledgeSource.create({
    data: {
      workspaceId: input.workspaceId,
      kind: "MANUAL",
      title: buildCorrectionTitle(answer.question),
      // READY, not PENDING: there is nothing to ingest. The passage is already
      // written and it has to be retrievable before the same question is asked
      // again, which could be seconds from now.
      status: "READY",
      lastSyncedAt: new Date(),
      chunks: {
        create: {
          ordinal: 0,
          content: buildCorrectionChunk(answer.question, correction),
          citation: "Corrected by a human reviewer",
        },
      },
    },
    select: { id: true },
  });

  return { ok: true, verdict: "WRONG", knowledgeSourceId: source.id };
}

const MAX_TITLE_CHARS = 80;

function buildCorrectionTitle(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  const short =
    flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS)}...` : flat;
  return `Correction: ${short}`;
}

/**
 * The question first, then the answer.
 *
 * Retrieval scores this chunk against the customer's next message, and the
 * terms in that message look like the terms in the question, not like the terms
 * in a well-written answer. Keeping the question verbatim is what makes the
 * correction win the ranking for the phrasing that failed.
 */
export function buildCorrectionChunk(question: string, correction: string): string {
  return `Question a customer asked: ${question.trim()}\n\nCorrect answer: ${correction.trim()}`;
}
