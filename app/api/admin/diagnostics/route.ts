import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getWorkerAlerts, getWorkerHealth } from "@/lib/ops/worker-health";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

/**
 * This workspace's own backlog, in the shape the page already renders.
 *
 * The queue itself has no tenant dimension, so asking BullMQ for job counts
 * reports every workspace's work. These come from DmLog, which is scoped, and
 * mean the same thing to the person reading the page: what of mine is waiting,
 * and what of mine broke.
 */
async function workspaceQueueCounts(
  workspaceId: string
): Promise<Record<string, number>> {
  const [waiting, failed] = await Promise.all([
    prisma.dmLog.count({ where: { workspaceId, status: "PENDING" } }),
    prisma.dmLog.count({ where: { workspaceId, status: "FAILED" } }),
  ]);
  return { waiting, failed };
}

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // This route sits under /admin/ and reports infrastructure state, and it had
  // no role check at all: any member of any tenant could read it. Diagnostics
  // are an operator concern, so they need the same gate every other write-shaped
  // surface uses.
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can view diagnostics" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const [
    queueCounts,
    workerHealth,
    workerAlerts,
    webhookFailures,
    dmFailures,
    tokenRefreshFailures,
    operationalEvents,
  ] = await Promise.all([
    // Queue depth is fleet-wide: it counts every tenant's jobs. Reporting it
    // here told each workspace how busy every other one is. This workspace's
    // own backlog is what the page actually needs, and DmLog is scoped.
    workspaceQueueCounts(workspaceId),
    getWorkerHealth(),
    getWorkerAlerts(10),
    prisma.webhookEvent.findMany({
      where: { workspaceId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        object: true,
        errorMessage: true,
        createdAt: true,
        processedAt: true,
      },
    }),
    prisma.dmLog.findMany({
      where: {
        workspaceId,
        status: {
          in: [
            "FAILED",
            "SKIPPED_RATE_LIMIT",
            "SKIPPED_PLAN_LIMIT",
            "SKIPPED_NO_MATCH",
          ],
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        commentId: true,
        commentText: true,
        errorMessage: true,
        updatedAt: true,
        automation: { select: { name: true } },
      },
    }),
    prisma.operationalEvent.findMany({
      where: { workspaceId, source: "TOKEN_REFRESH", level: "ERROR" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        message: true,
        createdAt: true,
        payload: true,
      },
    }),
    // Scoped to this workspace only. This previously unioned
    // `workspaceId: null`, which is where system-wide events land, so every
    // tenant could read the platform's own operational feed.
    prisma.operationalEvent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        source: true,
        level: true,
        message: true,
        createdAt: true,
        resolvedAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      queueCounts,
      workerHealth,
      workerAlerts,
      webhookFailures,
      dmFailures,
      tokenRefreshFailures,
      operationalEvents,
    },
  });
}
