import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { isCronRequest } from "@/lib/security/cron-auth";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import {
  refreshLongLivedToken,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";

const DAYS_BEFORE_EXPIRY = 10;

// How many accounts one run will refresh. See the orderBy below for why a cap
// here does not starve anyone.
const MAX_ACCOUNTS_PER_RUN = Number(
  process.env.TOKEN_REFRESH_MAX_PER_RUN ?? 200
);

export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + DAYS_BEFORE_EXPIRY);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const usageReset = await prisma.workspace.updateMany({
    where: { usagePeriodStart: { lt: monthStart } },
    data: {
      usagePeriodStart: monthStart,
      dmsSentThisPeriod: 0,
    },
  });

  const accountsToRefresh = await prisma.instagramAccount.findMany({
    where: {
      accessToken: { not: "" },
      tokenExpiresAt: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      instagramId: true,
      accessToken: true,
    },
    // Soonest to expire first, with a ceiling. This ran unbounded and serially,
    // one Meta call per account, inside a serverless handler on a 120 second
    // pg_cron timeout: at a few hundred accounts it timed out mid loop and the
    // rest were skipped for the day, silently.
    //
    // Ordering by expiry makes the cap self correcting rather than starving
    // anyone: whatever is skipped today sits nearer the front tomorrow, and
    // long lived tokens have weeks of runway before it matters.
    orderBy: { tokenExpiresAt: "asc" },
    take: MAX_ACCOUNTS_PER_RUN,
  });

  const results: Array<{
    instagramAccountId: string;
    username: string;
    status: "refreshed" | "failed";
    error?: string;
  }> = [];

  for (const account of accountsToRefresh) {
    try {
      const currentToken = decryptToken(account.accessToken);
      const { accessToken: newToken, expiresIn } =
        await refreshLongLivedToken(currentToken);
      const encryptedToken = encryptToken(newToken);
      const newExpiry = new Date(Date.now() + expiresIn * 1000);

      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptedToken,
          tokenExpiresAt: newExpiry,
        },
      });

      // Re-assert the webhook field subscription while we hold a fresh token.
      // An account connected before a field was added to WEBHOOK_FIELDS stays
      // subscribed to the old, shorter list forever otherwise, and the symptom
      // is a trigger that silently never fires. Failure here must not fail the
      // refresh, which is the job that actually keeps the account working.
      try {
        await subscribeInstagramAccountToWebhooks(
          account.instagramId,
          newToken
        );
      } catch (subscribeError) {
        console.warn(
          `[cron] Webhook resubscribe failed for @${account.username}:`,
          subscribeError instanceof Error
            ? subscribeError.message
            : "Unknown error"
        );
      }

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "refreshed",
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      await prisma.operationalEvent.create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message: `Token refresh failed for @${account.username}: ${errorMessage}`,
          payload: {
            instagramAccountId: account.id,
            username: account.username,
          },
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      totalProcessed: accountsToRefresh.length,
      workspacesReset: usageReset.count,
      results,
    },
  });
}
