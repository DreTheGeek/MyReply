import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { isCronRequest } from "@/lib/security/cron-auth";
import {
  claimDueResyncs,
  failAbandonedIngests,
  runWebsiteIngest,
} from "@/lib/knowledge/ingest";

export const runtime = "nodejs";
// A crawl is the slowest thing this app does. Platforms that honour this give
// the tick room for a few sites; the page cap keeps any single one bounded.
export const maxDuration = 300;

/** How many stalled or due crawls one tick will run. */
const MAX_PER_TICK = 5;

/**
 * The backstop behind detached ingest.
 *
 * POST /api/knowledge hands the actual crawl to `after()`, which is fast and
 * needs no Redis, but which dies with its serverless invocation. This tick is
 * what makes the PENDING status honest:
 *
 *   1. Anything PENDING past the grace period is picked back up. Crawls are
 *      retried from their URL. Uploads cannot be, since nothing kept the file,
 *      so they are failed out with a message telling the operator to re-upload.
 *   2. Sources with syncEveryHours set are re-crawled when they come due.
 *
 * Auth matches the other cron routes: a bearer token compared against
 * CRON_SECRET. There is no fallback: see lib/security/cron-auth.ts.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await isCronRequest(request))) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const now = new Date();
  const abandoned = await failAbandonedIngests(now);
  const due = await claimDueResyncs(now, MAX_PER_TICK);

  // Retries first: a source stuck PENDING is one an operator is watching.
  const toRun = [...abandoned.websites, ...due].slice(0, MAX_PER_TICK);

  const results: Array<{
    sourceId: string;
    status: string;
    chunkCount: number;
    error: string | null;
  }> = [];

  for (const sourceId of toRun) {
    // runWebsiteIngest never throws: it records FAILED with a message instead.
    // The wrapper is only here so one unexpected database error cannot stop the
    // rest of the tick.
    try {
      const outcome = await runWebsiteIngest(sourceId);
      results.push({
        sourceId,
        status: outcome.status,
        chunkCount: outcome.chunkCount,
        error: outcome.errorMessage,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown ingest error";
      await prisma.knowledgeSource
        .update({
          where: { id: sourceId },
          data: { status: "FAILED", errorMessage: message.slice(0, 500) },
        })
        .catch(() => undefined);
      results.push({
        sourceId,
        status: "FAILED",
        chunkCount: 0,
        error: message,
      });
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      abandonedUploadsFailed: abandoned.documents,
      stalledCrawlsRetried: abandoned.websites.length,
      scheduledResyncs: due.length,
      results,
    },
  });
}
