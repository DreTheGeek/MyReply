import { Prisma } from "@/app/generated/prisma/client";
import type { ChannelPlatform, UsageKind } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Usage metering: what each workspace used, by day, platform and kind.
 *
 * Recording never fails the thing being recorded. A message that was sent has
 * been sent; refusing to admit it because a counter write failed would only
 * make the worker retry a delivery that already happened. A failed write is
 * logged with its numbers so it can be put back by hand.
 */

export interface UsageEntry {
  workspaceId: string;
  platform: ChannelPlatform;
  kind: UsageKind;
  count?: number;
  costMicros?: number;
  platformFeeMicros?: number;
  at?: Date;
}

/** The UTC calendar day a moment falls on, as the Date a DATE column holds. */
export function usageDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export async function recordUsage(entry: UsageEntry): Promise<void> {
  const count = entry.count ?? 1;
  const costMicros = BigInt(Math.max(0, Math.round(entry.costMicros ?? 0)));
  const platformFeeMicros = BigInt(Math.max(0, Math.round(entry.platformFeeMicros ?? 0)));
  const day = usageDay(entry.at ?? new Date());
  const where = {
    workspaceId_day_platform_kind: {
      workspaceId: entry.workspaceId,
      day,
      platform: entry.platform,
      kind: entry.kind,
    },
  };
  const increment = {
    count: { increment: count },
    costMicros: { increment: costMicros },
    platformFeeMicros: { increment: platformFeeMicros },
  };

  try {
    await prisma.usageDaily.upsert({
      where,
      create: {
        workspaceId: entry.workspaceId,
        day,
        platform: entry.platform,
        kind: entry.kind,
        count,
        costMicros,
        platformFeeMicros,
      },
      update: increment,
    });
  } catch (error) {
    // Two first-of-the-day writes raced to create the row; the loser adds to it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      try {
        await prisma.usageDaily.update({ where, data: increment });
        return;
      } catch (retryError) {
        error = retryError;
      }
    }
    console.error("[usage] Could not record usage:", {
      workspaceId: entry.workspaceId,
      platform: entry.platform,
      kind: entry.kind,
      count,
      costMicros: costMicros.toString(),
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

export interface UsageTotals {
  messagesSent: number;
  publicReplies: number;
  aiReplies: number;
  aiCostMicros: number;
  platformFeeMicros: number;
}

export interface UsageReport {
  from: string;
  to: string;
  totals: UsageTotals;
  byPlatform: ({ platform: ChannelPlatform } & UsageTotals)[];
  byDay: ({ day: string } & UsageTotals)[];
}

function emptyTotals(): UsageTotals {
  return { messagesSent: 0, publicReplies: 0, aiReplies: 0, aiCostMicros: 0, platformFeeMicros: 0 };
}

function add(
  totals: UsageTotals,
  row: { kind: UsageKind; count: number; costMicros: bigint; platformFeeMicros: bigint }
): void {
  if (row.kind === "MESSAGE_SENT") totals.messagesSent += row.count;
  if (row.kind === "PUBLIC_REPLY") totals.publicReplies += row.count;
  if (row.kind === "AI_REPLY") {
    totals.aiReplies += row.count;
    totals.aiCostMicros += Number(row.costMicros);
  }
  totals.platformFeeMicros += Number(row.platformFeeMicros);
}

function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** One workspace's usage between two UTC days, inclusive. */
export async function usageReport(workspaceId: string, from: Date, to: Date): Promise<UsageReport> {
  const rows = await prisma.usageDaily.findMany({
    where: { workspaceId, day: { gte: usageDay(from), lte: usageDay(to) } },
    orderBy: { day: "asc" },
    select: { day: true, platform: true, kind: true, count: true, costMicros: true, platformFeeMicros: true },
  });

  const totals = emptyTotals();
  const platforms = new Map<ChannelPlatform, UsageTotals>();
  const days = new Map<string, UsageTotals>();
  for (const row of rows) {
    add(totals, row);
    const platform = platforms.get(row.platform) ?? emptyTotals();
    add(platform, row);
    platforms.set(row.platform, platform);
    const key = isoDay(row.day);
    const day = days.get(key) ?? emptyTotals();
    add(day, row);
    days.set(key, day);
  }

  return {
    from: isoDay(usageDay(from)),
    to: isoDay(usageDay(to)),
    totals,
    byPlatform: [...platforms].map(([platform, value]) => ({ platform, ...value })),
    byDay: [...days].map(([day, value]) => ({ day, ...value })),
  };
}

/** Every one of a partner's workspaces, with its totals for the range. */
export async function partnerUsageReport(
  partnerId: string,
  from: Date,
  to: Date
): Promise<{ from: string; to: string; workspaces: ({ workspaceId: string; externalId: string | null } & UsageTotals)[] }> {
  const rows = await prisma.usageDaily.findMany({
    where: { workspace: { partnerId }, day: { gte: usageDay(from), lte: usageDay(to) } },
    select: {
      workspaceId: true,
      kind: true,
      count: true,
      costMicros: true,
      platformFeeMicros: true,
      workspace: { select: { externalId: true } },
    },
  });

  const byWorkspace = new Map<string, { externalId: string | null; totals: UsageTotals }>();
  for (const row of rows) {
    const entry = byWorkspace.get(row.workspaceId) ?? {
      externalId: row.workspace.externalId,
      totals: emptyTotals(),
    };
    add(entry.totals, row);
    byWorkspace.set(row.workspaceId, entry);
  }

  return {
    from: isoDay(usageDay(from)),
    to: isoDay(usageDay(to)),
    workspaces: [...byWorkspace].map(([workspaceId, entry]) => ({
      workspaceId,
      externalId: entry.externalId,
      ...entry.totals,
    })),
  };
}
