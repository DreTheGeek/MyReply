import type { DmStatus, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getCurrentDMCount, RATE_LIMIT_MAX } from "@/lib/utils/rate-limiter";
import type {
  AccountPanelRow,
  ActivityRow,
  AlertLevel,
  BoardRow,
  PortalSummary,
  RailTask,
} from "@/lib/portal/types";

const DAY_MS = 86_400_000;
const LANE_ROWS = 8;
const SERIES_DAYS = 14;

/**
 * Ceiling on how many timestamps are pulled to build the sparklines. The
 * alternative is a raw grouped-by-day query, which would have to be written
 * against the schema-qualified table name and would not survive a schema
 * rename. At 14 days of history this cap is far above real volume, and a
 * workspace that exceeds it gets a sparkline built from its most recent rows
 * rather than a slow page.
 */
const SERIES_ROW_CAP = 20_000;

const SKIPPED: DmStatus[] = [
  "SKIPPED_DEDUP",
  "SKIPPED_RATE_LIMIT",
  "SKIPPED_PLAN_LIMIT",
  "SKIPPED_NO_MATCH",
];

/** Everything that means a send did not land and a person may need to look. */
const ATTENTION: DmStatus[] = ["FAILED", ...SKIPPED];

function startOfDay(date: Date): number {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

/** Buckets timestamps into the trailing SERIES_DAYS days, oldest first. */
function toSeries(dates: Date[], now: Date): number[] {
  const series = new Array<number>(SERIES_DAYS).fill(0);
  const today = startOfDay(now);

  for (const date of dates) {
    const offset = Math.floor((today - startOfDay(date)) / DAY_MS);
    const index = SERIES_DAYS - 1 - offset;
    if (index >= 0 && index < SERIES_DAYS) series[index] += 1;
  }
  return series;
}

/**
 * Percent change as a display string. Returns null when there is no prior
 * period to compare against, because "+100%" against zero is noise rather
 * than information.
 */
function comparisonLabel(
  current: number,
  previous: number,
  period: string
): string | null {
  if (previous === 0) return current === 0 ? null : `First ${period} of activity`;
  const change = Math.round(((current - previous) / previous) * 100);
  const sign = change > 0 ? "+" : "";
  return `${sign}${change}% vs last ${period}`;
}

function countsByStatus(
  rows: Array<{ status: DmStatus; _count: { _all: number } }>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row._count._all;
  return out;
}

function sumOf(counts: Record<string, number>, statuses: DmStatus[]): number {
  return statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);
}

export interface PortalSummaryInput {
  workspaceId: string;
  userName: string | null;
  /** Null means every account in the workspace. */
  instagramAccountId: string | null;
}

export async function buildPortalSummary({
  workspaceId,
  userName,
  instagramAccountId,
}: PortalSummaryInput): Promise<PortalSummary> {
  const now = new Date();
  const last30 = new Date(now.getTime() - 30 * DAY_MS);
  const prev30 = new Date(now.getTime() - 60 * DAY_MS);
  const last14 = new Date(now.getTime() - SERIES_DAYS * DAY_MS);
  const last7 = new Date(now.getTime() - 7 * DAY_MS);
  const last24h = new Date(now.getTime() - DAY_MS);
  const last12h = new Date(now.getTime() - DAY_MS / 2);
  const lastHour = new Date(now.getTime() - 3_600_000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const accountScope = instagramAccountId
    ? { instagramAccountId }
    : {};
  const logScope: Prisma.DmLogWhereInput = { workspaceId, ...accountScope };
  const clickScope: Prisma.LinkClickWhereInput = { workspaceId, ...accountScope };

  const [
    current30,
    previous30,
    sentDates,
    attentionDates,
    clickDates,
    clickers30,
    clickersPrev30,
    monthStatus,
    monthClickGroups,
    keywordRows,
    liveCampaigns,
    liveCount,
    sentPerCampaign7d,
    inFlightRows,
    inFlightCount,
    attentionRows,
    attentionCount,
    recentRows,
    accounts,
    sentPerAccount7d,
    alertRows,
    alertTotal,
    failed24h,
    sentLastHourPerAccount,
    workspace,
  ] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["status"],
      where: { ...logScope, createdAt: { gte: last30 } },
      _count: { _all: true },
    }),
    prisma.dmLog.groupBy({
      by: ["status"],
      where: { ...logScope, createdAt: { gte: prev30, lt: last30 } },
      _count: { _all: true },
    }),
    prisma.dmLog.findMany({
      where: { ...logScope, status: "SENT", createdAt: { gte: last14 } },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
      take: SERIES_ROW_CAP,
    }),
    prisma.dmLog.findMany({
      where: {
        ...logScope,
        status: { in: ATTENTION },
        createdAt: { gte: last14 },
      },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
      take: SERIES_ROW_CAP,
    }),
    prisma.linkClick.findMany({
      where: { ...clickScope, createdAt: { gte: last14 } },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
      take: SERIES_ROW_CAP,
    }),
    // Grouped by ipHash rather than counted, because a click rate is people
    // who clicked over DMs delivered. Counting raw rows lets one person
    // clicking twice produce a rate above 100%, which is not a rate.
    prisma.linkClick.groupBy({
      by: ["ipHash"],
      where: { ...clickScope, createdAt: { gte: last30 } },
      _count: { _all: true },
    }),
    prisma.linkClick.groupBy({
      by: ["ipHash"],
      where: { ...clickScope, createdAt: { gte: prev30, lt: last30 } },
      _count: { _all: true },
    }),
    prisma.dmLog.groupBy({
      by: ["status"],
      where: { ...logScope, createdAt: { gte: monthStart } },
      _count: { _all: true },
    }),
    // Grouped so the panel can show total taps and compute its rate from
    // distinct people, without a second query.
    prisma.linkClick.groupBy({
      by: ["ipHash"],
      where: { ...clickScope, createdAt: { gte: monthStart } },
      _count: { _all: true },
    }),
    prisma.dmLog.groupBy({
      by: ["matchedKeyword"],
      where: {
        ...logScope,
        createdAt: { gte: monthStart },
        matchedKeyword: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { matchedKeyword: "desc" } },
      take: 5,
    }),
    prisma.automation.findMany({
      where: { workspaceId, isActive: true, ...accountScope },
      orderBy: { createdAt: "desc" },
      take: LANE_ROWS,
      select: {
        id: true,
        name: true,
        keywords: true,
        matchAnyPost: true,
        instagramAccount: { select: { username: true } },
      },
    }),
    prisma.automation.count({
      where: { workspaceId, isActive: true, ...accountScope },
    }),
    prisma.dmLog.groupBy({
      by: ["automationId"],
      where: { ...logScope, status: "SENT", createdAt: { gte: last7 } },
      _count: { _all: true },
    }),
    prisma.dmLog.findMany({
      where: { ...logScope, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: LANE_ROWS,
      select: {
        id: true,
        commenterName: true,
        createdAt: true,
        automation: { select: { name: true } },
      },
    }),
    prisma.dmLog.count({ where: { ...logScope, status: "PENDING" } }),
    prisma.dmLog.findMany({
      where: { ...logScope, status: { in: ATTENTION }, createdAt: { gte: last7 } },
      orderBy: { createdAt: "desc" },
      take: LANE_ROWS,
      select: {
        id: true,
        commenterName: true,
        status: true,
        errorMessage: true,
        automation: { select: { name: true } },
      },
    }),
    prisma.dmLog.count({
      where: { ...logScope, status: { in: ATTENTION }, createdAt: { gte: last7 } },
    }),
    prisma.dmLog.findMany({
      where: logScope,
      orderBy: { createdAt: "desc" },
      take: LANE_ROWS,
      select: {
        id: true,
        commenterName: true,
        status: true,
        createdAt: true,
        automation: { select: { name: true } },
      },
    }),
    prisma.instagramAccount.findMany({
      where: {
        workspaceId,
        ...(instagramAccountId ? { id: instagramAccountId } : {}),
      },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
    prisma.dmLog.groupBy({
      by: ["instagramAccountId"],
      where: { ...logScope, status: "SENT", createdAt: { gte: last7 } },
      _count: { _all: true },
    }),
    prisma.operationalEvent.findMany({
      where: { workspaceId, resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        level: true,
        message: true,
        createdAt: true,
        source: true,
      },
    }),
    prisma.operationalEvent.count({ where: { workspaceId, resolvedAt: null } }),
    prisma.dmLog.count({
      where: { ...logScope, status: "FAILED", createdAt: { gte: last24h } },
    }),
    prisma.dmLog.groupBy({
      by: ["instagramAccountId"],
      where: { ...logScope, status: "SENT", createdAt: { gte: lastHour } },
      _count: { _all: true },
    }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { dmsSentThisPeriod: true, usagePeriodStart: true },
    }),
  ]);

  const current = countsByStatus(current30);
  const previous = countsByStatus(previous30);
  const month = countsByStatus(monthStatus);

  const sent30 = current.SENT ?? 0;
  const sentPrev30 = previous.SENT ?? 0;
  const attention30 = sumOf(current, ATTENTION);
  const attentionPrev30 = sumOf(previous, ATTENTION);

  // One group per distinct ipHash, so this is people rather than taps.
  const uniqueClickers30 = clickers30.length;
  const uniqueClickersPrev30 = clickersPrev30.length;

  const clickRate30 =
    sent30 > 0 ? Math.round((uniqueClickers30 / sent30) * 100) : 0;
  const clickRatePrev =
    sentPrev30 > 0 ? Math.round((uniqueClickersPrev30 / sentPrev30) * 100) : 0;

  // Capacity is the tightest account, not an average: one account at its cap
  // is throttled regardless of how idle the others are. Redis is the source of
  // truth here, and a blip falls back to counting sends in the trailing hour
  // rather than failing the whole portal.
  let capacityPercent = 0;
  let capacityFromRedis = true;
  try {
    const counts = await Promise.all(
      accounts.map((account) => getCurrentDMCount(account.id))
    );
    capacityPercent = counts.length
      ? Math.round((Math.max(...counts, 0) / RATE_LIMIT_MAX) * 100)
      : 0;
  } catch {
    capacityFromRedis = false;
    const perAccount = sentLastHourPerAccount.map((row) => row._count._all);
    capacityPercent = perAccount.length
      ? Math.round((Math.max(...perAccount, 0) / RATE_LIMIT_MAX) * 100)
      : 0;
  }

  const errorAlerts = alertRows.filter((alert) => alert.level === "ERROR").length;
  const expiringAccounts = accounts.filter(
    (account) =>
      account.tokenExpiresAt !== null &&
      account.tokenExpiresAt.getTime() - now.getTime() < 7 * DAY_MS
  );
  const unsubscribed = accounts.filter((account) => !account.webhookSubscribed);

  const healthProblem =
    errorAlerts > 0
      ? `${errorAlerts} error${errorAlerts === 1 ? "" : "s"} logged`
      : expiringAccounts.length > 0
        ? "Token expiring soon"
        : unsubscribed.length > 0
          ? "Webhook not subscribed"
          : null;

  const sentPerCampaign = new Map(
    sentPerCampaign7d.map((row) => [row.automationId, row._count._all])
  );
  const sentPerAccount = new Map(
    sentPerAccount7d.map((row) => [row.instagramAccountId, row._count._all])
  );

  const liveRows: BoardRow[] = liveCampaigns.map((campaign) => ({
    id: campaign.id,
    primary: campaign.name,
    secondary: `@${campaign.instagramAccount.username}, ${
      campaign.keywords.length
    } keyword${campaign.keywords.length === 1 ? "" : "s"}${
      campaign.matchAnyPost ? ", any post" : ""
    }`,
    status: `${sentPerCampaign.get(campaign.id) ?? 0} sent`,
    tone: "good",
  }));

  const inFlight: BoardRow[] = inFlightRows.map((row) => ({
    id: row.id,
    primary: `@${row.commenterName ?? "unknown"}`,
    secondary: row.automation.name,
    status: "Queued",
    tone: "pending",
  }));

  const attentionBoard: BoardRow[] = attentionRows.map((row) => ({
    id: row.id,
    primary: `@${row.commenterName ?? "unknown"}`,
    secondary: row.errorMessage ?? row.automation.name,
    status: row.status === "FAILED" ? "Failed" : "Skipped",
    tone: row.status === "FAILED" ? "risk" : "neutral",
  }));

  const recentActivity: ActivityRow[] = recentRows.map((row) => ({
    id: row.id,
    commenterName: row.commenterName,
    campaignName: row.automation.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }));

  const accountPanel: AccountPanelRow[] = accounts.map((account) => ({
    id: account.id,
    username: account.username,
    instagramId: account.instagramId,
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
    webhookSubscribed: account.webhookSubscribed,
    dmsLast7Days: sentPerAccount.get(account.id) ?? 0,
  }));

  // Tasks are derived from live state every time rather than stored, so one
  // clears itself the moment the underlying condition is fixed.
  const tasks: RailTask[] = [];
  for (const account of expiringAccounts) {
    tasks.push({
      id: `token-${account.id}`,
      label: `Reconnect @${account.username}`,
      detail: "The Instagram token expires within a week.",
      href: "/settings",
      severity: "error",
    });
  }
  for (const account of unsubscribed) {
    tasks.push({
      id: `webhook-${account.id}`,
      label: `@${account.username} is not receiving events`,
      detail: "The webhook subscription is not active, so comments are missed.",
      href: "/settings",
      severity: "error",
    });
  }
  if (failed24h > 0) {
    tasks.push({
      id: `failed-24h`,
      label: `${failed24h} DM${failed24h === 1 ? "" : "s"} failed`,
      detail: "In the last 24 hours.",
      href: "/logs?status=FAILED",
      severity: "warning",
    });
  }
  const deadCampaigns = liveCampaigns.filter(
    (campaign) => campaign.keywords.length === 0
  );
  for (const campaign of deadCampaigns) {
    tasks.push({
      id: `campaign-${campaign.id}`,
      label: `${campaign.name} has no keywords`,
      detail: "It is live but nothing can trigger it.",
      href: `/campaigns`,
      severity: "warning",
    });
  }

  const sentLast12h = sentDates.filter(
    (row) => row.createdAt.getTime() >= last12h.getTime()
  ).length;

  const needsYouCount = tasks.length;
  const overnight =
    sentLast12h === 0 && needsYouCount === 0
      ? "Quiet in the last 12 hours, and nothing is waiting on you."
      : sentLast12h === 0
        ? `No DMs went out in the last 12 hours, and ${needsYouCount} thing${
            needsYouCount === 1 ? "" : "s"
          } need${needsYouCount === 1 ? "s" : ""} you.`
        : needsYouCount === 0
          ? `${sentLast12h} DM${sentLast12h === 1 ? "" : "s"} went out in the last 12 hours, and nothing needs you.`
          : `${sentLast12h} DM${sentLast12h === 1 ? "" : "s"} went out in the last 12 hours, and ${needsYouCount} thing${
              needsYouCount === 1 ? "" : "s"
            } need${needsYouCount === 1 ? "s" : ""} you.`;

  return {
    greeting: { userName, overnight, needsYouCount },
    kpis: {
      dmsDelivered: {
        label: "DMs delivered",
        value: sent30.toLocaleString(),
        comparison: comparisonLabel(sent30, sentPrev30, "month"),
        series: toSeries(
          sentDates.map((row) => row.createdAt),
          now
        ),
      },
      needsAttention: {
        label: "Needs attention",
        value: attention30.toLocaleString(),
        comparison: comparisonLabel(attention30, attentionPrev30, "month"),
        series: toSeries(
          attentionDates.map((row) => row.createdAt),
          now
        ),
      },
      capacityUsed: {
        label: "Capacity used",
        value: `${capacityPercent}%`,
        comparison: capacityFromRedis
          ? `of ${RATE_LIMIT_MAX}/hour on the busiest account`
          : `estimated from sends, live counter unavailable`,
        series: [],
      },
      systemHealth: {
        label: "System health",
        value: healthProblem ? "Attention" : "Healthy",
        comparison: healthProblem ?? "Tokens, webhooks and workers all clear",
        series: [],
      },
      clickRate: {
        label: "Click rate",
        value: `${clickRate30}%`,
        comparison:
          comparisonLabel(clickRate30, clickRatePrev, "month") ??
          "People who clicked, over DMs delivered",
        series: toSeries(
          clickDates.map((row) => row.createdAt),
          now
        ),
      },
    },
    board: {
      live: { count: liveCount, rows: liveRows },
      inFlight: { count: inFlightCount, rows: inFlight },
      needsAttention: { count: attentionCount, rows: attentionBoard },
    },
    panels: {
      recentActivity,
      performance: {
        sent: month.SENT ?? 0,
        failed: month.FAILED ?? 0,
        skipped: sumOf(month, SKIPPED),
        clicks: monthClickGroups.reduce(
          (total, group) => total + group._count._all,
          0
        ),
        clickRate:
          (month.SENT ?? 0) > 0
            ? Math.round((monthClickGroups.length / (month.SENT ?? 1)) * 100)
            : 0,
        topKeywords: keywordRows
          .filter((row) => row.matchedKeyword !== null)
          .map((row) => ({
            keyword: row.matchedKeyword as string,
            count: row._count._all,
          })),
      },
      accounts: accountPanel,
    },
    alerts: {
      items: alertRows.map((alert) => ({
        id: alert.id,
        level: alert.level as AlertLevel,
        message: alert.message,
        createdAt: alert.createdAt.toISOString(),
        source: alert.source,
      })),
      total: alertTotal,
    },
    tasks,
    usage: {
      dmsThisPeriod: workspace?.dmsSentThisPeriod ?? 0,
      periodStart: (workspace?.usagePeriodStart ?? now).toISOString(),
      limit: null,
    },
  };
}
