/**
 * Running an ingest and recording what happened to it.
 *
 * The contract every caller relies on: a KnowledgeSource never stays PENDING
 * because something went wrong. Every path out of this module ends in READY or
 * FAILED, and FAILED always carries a message an operator can read and act on.
 * The catch blocks here are broad on purpose, because the alternative is a row
 * that sits PENDING forever while the person who added it has no idea why.
 *
 * Why ingest does not run inside the request:
 *   A crawl of 100 pages takes minutes. The API creates the row, returns
 *   PENDING, and hands the work to Next's `after()`, which runs once the
 *   response has been flushed. The cron route at /api/cron/ingest-knowledge is
 *   the safety net behind that: it picks up anything still PENDING after a
 *   grace period, runs scheduled re-syncs, and fails out uploads whose process
 *   died before it finished. BullMQ was the other option and was not taken,
 *   because its worker lives in worker/dm-worker.ts and its queue needs Redis.
 *   Adding a second queue would mean a second worker process and a Redis
 *   requirement for self-hosters who today run the web app alone.
 */

import type { KnowledgeStatus } from "@/app/generated/prisma/client";
import { embedChunksForSource } from "@/lib/ai/embeddings";
import { prisma } from "@/lib/db/client";
import { chunkQuestionAndAnswer, chunkText, type TextChunk } from "./chunk";
import { CrawlError, crawlSite, type CrawlOptions } from "./crawl";
import {
  DocumentError,
  chunkDocument,
  type DocumentKind,
} from "./documents";

/** Ceiling on stored passages per source, so one crawl cannot flood the table. */
export const MAX_CHUNKS_PER_SOURCE = 5_000;

/** How long a PENDING row may sit before the cron treats it as abandoned. */
export const PENDING_GRACE_MINUTES = 15;

export interface IngestOutcome {
  status: KnowledgeStatus;
  chunkCount: number;
  errorMessage: string | null;
}

/** Injection points, so tests can drive ingest without a network. */
export interface IngestDeps {
  crawl?: typeof crawlSite;
  crawlOptions?: CrawlOptions;
  now?: () => Date;
}

/**
 * Replace a source's passages and mark it READY, in one transaction. A resync
 * that fails mid-write must not leave half the old chunks and half the new
 * ones, because the answer layer would then cite passages that contradict
 * each other.
 */
async function commitChunks(
  sourceId: string,
  chunks: TextChunk[],
  title: string | null,
  now: Date
): Promise<IngestOutcome> {
  const capped = chunks.slice(0, MAX_CHUNKS_PER_SOURCE);

  await prisma.$transaction([
    prisma.knowledgeChunk.deleteMany({ where: { sourceId } }),
    prisma.knowledgeChunk.createMany({
      data: capped.map((chunk, ordinal) => ({
        sourceId,
        ordinal,
        content: chunk.content,
        citation: chunk.citation,
      })),
    }),
    prisma.knowledgeSource.update({
      where: { id: sourceId },
      data: {
        status: "READY",
        errorMessage: null,
        lastSyncedAt: now,
        ...(title ? { title } : {}),
      },
    }),
  ]);

  // Embed outside the transaction, on purpose. The passages are already
  // committed and retrieval works on them lexically the moment they land, so an
  // embedder that is slow, unreachable or not yet deployed must not roll back
  // an ingest that otherwise succeeded. This never throws: it leaves embedding
  // null and the backfill picks those rows up later.
  await embedChunksForSource(sourceId);

  return { status: "READY", chunkCount: capped.length, errorMessage: null };
}

/** Trim a message to something that fits a table cell and still explains itself. */
function readableError(error: unknown): string {
  if (error instanceof CrawlError || error instanceof DocumentError) {
    return error.message.slice(0, 500);
  }
  if (error instanceof Error && error.message !== "") {
    return error.message.slice(0, 500);
  }
  return "Ingest failed for an unknown reason. Try re-syncing.";
}

async function markFailed(
  sourceId: string,
  message: string
): Promise<IngestOutcome> {
  await prisma.knowledgeSource.update({
    where: { id: sourceId },
    data: { status: "FAILED", errorMessage: message },
  });
  return { status: "FAILED", chunkCount: 0, errorMessage: message };
}

/**
 * Crawl a WEBSITE source and store its passages.
 *
 * Never throws. Every failure becomes a FAILED row with a message, because this
 * runs detached from the request that started it and there is nobody left to
 * catch an exception.
 */
export async function runWebsiteIngest(
  sourceId: string,
  deps: IngestDeps = {}
): Promise<IngestOutcome> {
  const crawl = deps.crawl ?? crawlSite;
  const now = deps.now ?? ((): Date => new Date());

  const source = await prisma.knowledgeSource.findUnique({
    where: { id: sourceId },
    select: { id: true, kind: true, url: true, crawlDepth: true, title: true },
  });

  if (!source) {
    // Deleted while queued. Nothing to record, and nothing went wrong.
    return { status: "FAILED", chunkCount: 0, errorMessage: null };
  }

  if (source.kind !== "WEBSITE" || !source.url) {
    return markFailed(sourceId, "This source has no address to crawl");
  }

  try {
    const result = await crawl(source.url, {
      depth: source.crawlDepth,
      ...deps.crawlOptions,
    });

    const chunks: TextChunk[] = [];
    for (const page of result.pages) {
      // The citation names the page, then its address, so an answer can say
      // where it came from and a reader can go and check.
      const citation = page.title ? `${page.title} (${page.url})` : page.url;
      chunks.push(...chunkText(page.text, citation));
      if (chunks.length >= MAX_CHUNKS_PER_SOURCE) break;
    }

    if (chunks.length === 0) {
      return markFailed(
        sourceId,
        `Nothing readable was found at ${source.url}`
      );
    }

    // Adopt the root page's title on first sync, so the list shows something
    // better than a bare hostname. A title the operator set is left alone.
    const rootTitle = result.pages[0]?.title ?? null;
    const shouldRename =
      rootTitle !== null && source.title === new URL(source.url).hostname;

    return await commitChunks(
      sourceId,
      chunks,
      shouldRename ? rootTitle.slice(0, 120) : null,
      now()
    );
  } catch (error) {
    return markFailed(sourceId, readableError(error));
  }
}

export interface UploadedDocument {
  bytes: Uint8Array;
  kind: DocumentKind;
  filename: string;
}

/**
 * Parse an uploaded file and store its passages.
 *
 * The bytes are passed in rather than re-read, because MyReply has no blob
 * store: an upload exists only in the request that carried it. That is also why
 * a DOCUMENT source cannot be re-synced, and why the cron fails out any upload
 * left PENDING rather than trying to retry it.
 */
export async function runDocumentIngest(
  sourceId: string,
  file: UploadedDocument,
  deps: IngestDeps = {}
): Promise<IngestOutcome> {
  const now = deps.now ?? ((): Date => new Date());

  try {
    const chunks = await chunkDocument(file.bytes, file.kind, file.filename);
    if (chunks.length === 0) {
      return markFailed(sourceId, `${file.filename} had no readable text in it`);
    }
    return await commitChunks(sourceId, chunks, null, now());
  } catch (error) {
    return markFailed(sourceId, readableError(error));
  }
}

/** Store a question and answer pair as its single chunk. */
export async function runManualIngest(
  sourceId: string,
  question: string,
  answer: string,
  deps: IngestDeps = {}
): Promise<IngestOutcome> {
  const now = deps.now ?? ((): Date => new Date());

  try {
    return await commitChunks(
      sourceId,
      [chunkQuestionAndAnswer(question, answer)],
      null,
      now()
    );
  } catch (error) {
    return markFailed(sourceId, readableError(error));
  }
}

/**
 * Fail out sources that have been PENDING longer than the grace period.
 *
 * A crawl can be interrupted by a deploy or by a serverless invocation being
 * cut short, and an upload's bytes are gone the moment its request ends. Either
 * way the row would sit PENDING forever. This is what makes that impossible.
 */
export async function failAbandonedIngests(now: Date = new Date()): Promise<{
  websites: string[];
  documents: number;
}> {
  const cutoff = new Date(now.getTime() - PENDING_GRACE_MINUTES * 60_000);

  // An upload cannot be retried, because nothing kept the file.
  const documents = await prisma.knowledgeSource.updateMany({
    where: {
      status: "PENDING",
      kind: { in: ["DOCUMENT", "MANUAL"] },
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      errorMessage:
        "Processing stopped before it finished. Upload the file again to retry.",
    },
  });

  // A crawl can be, because its input is a URL we still have.
  const stalledCrawls = await prisma.knowledgeSource.findMany({
    where: {
      status: "PENDING",
      kind: "WEBSITE",
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
    take: 25,
  });

  const ids = stalledCrawls.map((source) => source.id);

  if (ids.length > 0) {
    // Touching the row pushes updatedAt forward, which is what stops a crawl
    // that reliably outlives its invocation from being retried on every single
    // tick. It gets one attempt per grace window instead.
    await prisma.knowledgeSource.updateMany({
      where: { id: { in: ids } },
      data: { status: "PENDING" },
    });
  }

  return { websites: ids, documents: documents.count };
}

/**
 * Website sources whose scheduled refresh is due, moved to PENDING so a second
 * cron tick cannot pick the same row up twice.
 */
export async function claimDueResyncs(
  now: Date = new Date(),
  limit = 10
): Promise<string[]> {
  const candidates = await prisma.knowledgeSource.findMany({
    where: {
      kind: "WEBSITE",
      status: { in: ["READY", "FAILED"] },
      syncEveryHours: { not: null },
    },
    select: { id: true, syncEveryHours: true, lastSyncedAt: true },
    take: limit * 4,
  });

  const due = candidates
    .filter((source) => {
      if (source.syncEveryHours === null) return false;
      if (!source.lastSyncedAt) return true;
      const dueAt =
        source.lastSyncedAt.getTime() + source.syncEveryHours * 3_600_000;
      return dueAt <= now.getTime();
    })
    .slice(0, limit)
    .map((source) => source.id);

  if (due.length === 0) return [];

  await prisma.knowledgeSource.updateMany({
    where: { id: { in: due } },
    data: { status: "PENDING", errorMessage: null },
  });

  return due;
}
