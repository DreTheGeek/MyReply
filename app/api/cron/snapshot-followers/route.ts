import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { isCronRequest } from "@/lib/security/cron-auth";
import { decryptToken } from "@/lib/meta/oauth";
import { getUserInfo } from "@/lib/meta/client";
import {
  backfillFollowerHistory,
  recordFollowerSnapshot,
} from "@/lib/reports/follower-history";

// How many accounts one run will snapshot.
const MAX_ACCOUNTS_PER_RUN = Number(
  process.env.TOKEN_SNAPSHOT_MAX_PER_RUN ?? 200
);

/**
 * Records one follower total per connected account per day.
 *
 * Instagram retains only ~30 days of account insights, so this job is the only
 * source of longer-range follower history. Missing a run loses that day
 * permanently — there is no way to backfill beyond the insights window.
 */
export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { accessToken: { not: "" } },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      instagramId: true,
      accessToken: true,
    },
    // Unbounded and serial, one Meta call each, in a serverless handler on a
    // 120 second pg_cron timeout. At a few hundred accounts it timed out mid
    // loop and the rest were skipped, and a missed follower snapshot loses that
    // day permanently: it cannot be backfilled from Instagram.
    //
    // Oldest connection first so the cap rotates rather than always cutting the
    // same tail.
    orderBy: { connectedAt: "asc" },
    take: MAX_ACCOUNTS_PER_RUN,
  });

  let recorded = 0;
  let backfilled = 0;
  const failures: Array<{ username: string; reason: string }> = [];

  for (const account of accounts) {
    try {
      const token = decryptToken(account.accessToken);
      const info = await getUserInfo(token);

      if (typeof info.followers_count !== "number") {
        failures.push({
          username: account.username,
          reason: "followers_count not returned",
        });
        continue;
      }

      await recordFollowerSnapshot(account.id, info.followers_count);
      recorded += 1;

      // First time we see this account, try to recover the last 30 days.
      const existing = await prisma.followerSnapshot.count({
        where: { instagramAccountId: account.id },
      });
      if (existing <= 1) {
        backfilled += await backfillFollowerHistory(
          account.id,
          token,
          account.instagramId,
          info.followers_count
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown error";
      failures.push({ username: account.username, reason });
      await prisma.operationalEvent
        .create({
          data: {
            source: "SYSTEM",
            level: "WARNING",
            workspaceId: account.workspaceId,
            message: "Follower snapshot failed",
            payload: { username: account.username, reason },
          },
        })
        .catch(() => {});
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      accounts: accounts.length,
      recorded,
      backfilled,
      failures,
    },
  });
}
