import { prisma } from "@/lib/db/client";
import { qualified } from "@/lib/db/schema";

/**
 * When this account's audience actually shows up.
 *
 * A 7 x 24 grid of day-of-week against hour-of-day, counted from every comment
 * the worker has processed. Nobody else in this category shows this, and it is
 * computed entirely from rows already being written.
 *
 * IT COUNTS EVERY COMMENT, NOT EVERY SEND. A DmLog row exists for comments that
 * matched nothing (SKIPPED_NO_MATCH) as well as ones that did, which is what
 * makes this an audience-behaviour chart rather than a campaign-performance
 * one. "When do people comment on my posts" is the question; whether a keyword
 * happened to fire is a different one.
 *
 * IT BUCKETS IN THE WORKSPACE'S TIMEZONE. Bucketing in UTC would put the
 * evening peak of a New York account at 11pm to 4am and make the chart worse
 * than useless, since the whole point is to read a local rhythm off it. This is
 * also what makes it compose with quiet hours: look at the grid, then set the
 * window so follow-ups land when people are actually awake.
 */

/** Rows are Sunday..Saturday, columns are hours 0..23. */
export type HeatmapMatrix = number[][];

export interface CommentHeatmap {
  matrix: HeatmapMatrix;
  /** The busiest single cell, so a caller can label it without re-scanning. */
  peak: { day: number; hour: number; count: number } | null;
  total: number;
  timezone: string;
  windowDays: number;
}

const DEFAULT_WINDOW_DAYS = 90;

function emptyMatrix(): HeatmapMatrix {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
}

export async function getCommentHeatmap(
  workspaceId: string,
  timezone: string,
  options: { windowDays?: number; instagramAccountId?: string | null } = {}
): Promise<CommentHeatmap> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Aggregated in the database: one row per populated cell, at most 168 of
  // them, however many comments the workspace has ever received.
  //
  // createdAt is `timestamp without time zone` holding UTC, so it is labelled
  // UTC first and then converted. Doing only the second half would read the
  // stored wall-clock as if it were already local and shift every bucket by
  // the offset.
  const rows = options.instagramAccountId
    ? await prisma.$queryRawUnsafe<
        { dow: number; hour: number; count: number }[]
      >(
        `SELECT EXTRACT(DOW  FROM ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE $2))::int AS dow,
                EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE $2))::int AS hour,
                COUNT(*)::int AS count
           FROM ${qualified("DmLog")}
          WHERE "workspaceId" = $1
            AND "createdAt" >= $3
            AND "instagramAccountId" = $4
          GROUP BY 1, 2`,
        workspaceId,
        timezone,
        since,
        options.instagramAccountId
      )
    : await prisma.$queryRawUnsafe<
        { dow: number; hour: number; count: number }[]
      >(
        `SELECT EXTRACT(DOW  FROM ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE $2))::int AS dow,
                EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE $2))::int AS hour,
                COUNT(*)::int AS count
           FROM ${qualified("DmLog")}
          WHERE "workspaceId" = $1
            AND "createdAt" >= $3
          GROUP BY 1, 2`,
        workspaceId,
        timezone,
        since
      );

  return buildHeatmap(rows, timezone, windowDays);
}

/**
 * Split from the query so the shaping is testable without a database, which is
 * where the off-by-one risks live.
 */
export function buildHeatmap(
  rows: { dow: number; hour: number; count: number }[],
  timezone: string,
  windowDays: number
): CommentHeatmap {
  const matrix = emptyMatrix();
  let total = 0;
  let peak: CommentHeatmap["peak"] = null;

  for (const row of rows) {
    // Postgres DOW is already 0 = Sunday, matching Date.getDay() and the row
    // order below. Guarded anyway: a malformed row must not write outside the
    // grid or silently land in the wrong day.
    if (row.dow < 0 || row.dow > 6 || row.hour < 0 || row.hour > 23) continue;

    matrix[row.dow][row.hour] = row.count;
    total += row.count;

    if (!peak || row.count > peak.count) {
      peak = { day: row.dow, hour: row.hour, count: row.count };
    }
  }

  return { matrix, peak, total, timezone, windowDays };
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "Tuesday around 7pm", for the sentence above the grid. */
export function describePeak(peak: CommentHeatmap["peak"]): string | null {
  if (!peak || peak.count === 0) return null;

  const hour = peak.hour % 12 === 0 ? 12 : peak.hour % 12;
  const meridiem = peak.hour < 12 ? "am" : "pm";
  return `${DAY_NAMES[peak.day]} around ${hour}${meridiem}`;
}
