import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { isCronRequest } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
// Health must reflect live state (worker heartbeat, queue depth), never a
// cached response, or it reports stale worker start times.
export const dynamic = "force-dynamic";

/**
 * Two audiences, two answers.
 *
 * Anyone may ask whether the app is up: that is what an uptime monitor and a
 * load balancer need, and gating it would break them. What they get back is
 * ok or error per subsystem and nothing else.
 *
 * The detail is a different thing. It used to be public, and it carried the
 * raw driver messages, which on a connection failure name the database host,
 * port and database name, or the internal Redis host, or say "password
 * authentication failed for user". It also returned fleet-wide BullMQ job
 * counts across every tenant, the exact leak /api/admin/diagnostics was fixed
 * for, and the worker's pid and container hostname. So an anonymous caller
 * could poll this during an incident and map the internal topology and read
 * total platform volume. Detail now requires the cron bearer.
 *
 * Every probe is also bounded. Production logs show 680 ECONNREFUSED and seven
 * 300 second function timeouts on this route, because ioredis is configured
 * with maxRetriesPerRequest null and retries forever. A health check that
 * hangs for five minutes is worse than one that reports a failure.
 */
const PROBE_TIMEOUT_MS = 3_000;

type CheckStatus = "ok" | "error";

interface HealthCheck {
  status: CheckStatus;
  /** Never sent to an unauthenticated caller. */
  detail?: string;
}

/** Resolves to a timeout result rather than hanging on an unreachable service. */
async function withTimeout<T>(
  work: () => Promise<T>,
  onTimeout: () => T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failed(error: unknown, fallback: string): HealthCheck {
  return {
    status: "error",
    detail: error instanceof Error ? error.message : fallback,
  };
}

async function checkDatabase(): Promise<HealthCheck> {
  return withTimeout(
    async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { status: "ok" as const };
      } catch (error) {
        return failed(error, "Database check failed");
      }
    },
    () => ({ status: "error", detail: "Database check timed out" })
  );
}

async function checkRedis(): Promise<HealthCheck> {
  return withTimeout(
    async () => {
      try {
        const pong = await getRedisConnection().ping();
        return pong === "PONG"
          ? { status: "ok" as const }
          : { status: "error" as const, detail: `Unexpected reply: ${pong}` };
      } catch (error) {
        return failed(error, "Redis check failed");
      }
    },
    () => ({ status: "error", detail: "Redis check timed out" })
  );
}

async function checkQueue(): Promise<
  HealthCheck & { counts?: Record<string, number> }
> {
  return withTimeout(
    async () => {
      try {
        const counts = await getDMQueue().getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed"
        );
        return { status: "ok" as const, counts };
      } catch (error) {
        return failed(error, "Queue check failed");
      }
    },
    () => ({ status: "error" as const, detail: "Queue check timed out" })
  );
}

/**
 * What is going wrong across the whole platform, not one tenant.
 *
 * Webhook signature failures and worker process errors are written with no
 * workspaceId, because at the moment they happen no tenant is known. Every
 * read path in the app is workspace-scoped, so those rows have never been
 * visible to anybody. They are the two most important operational signals in
 * the system and they went nowhere.
 *
 * This is the operator's view of them, behind the cron bearer, which already
 * lives in the vault and is already verified. No new auth mechanism, no new
 * secret, and nothing here is reachable by a tenant.
 */
async function fleetSignals() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [unresolvedByLevel, orphaned, recent] = await Promise.all([
    prisma.operationalEvent.groupBy({
      by: ["level"],
      where: { resolvedAt: null, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    // The ones nobody could see: no tenant, so no scoped query reaches them.
    prisma.operationalEvent.count({
      where: { workspaceId: null, resolvedAt: null, createdAt: { gte: since } },
    }),
    prisma.operationalEvent.findMany({
      where: { resolvedAt: null, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        level: true,
        message: true,
        createdAt: true,
        workspaceId: true,
      },
    }),
  ]);

  return {
    windowHours: 24,
    unresolved: Object.fromEntries(
      unresolvedByLevel.map((row) => [row.level, row._count._all])
    ),
    platformLevel: orphaned,
    recent: recent.map((event) => ({
      level: event.level,
      message: event.message,
      at: event.createdAt.toISOString(),
      scope: event.workspaceId ? "workspace" : "platform",
    })),
  };
}

export async function GET(request: Request) {
  // Reads the shared secret from the vault, so the detail view and the
  // scheduler agree about who the caller is.
  const detailed = await isCronRequest(request);

  const [database, redis, queue, worker] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    getWorkerHealth().catch((error) => ({
      healthy: false,
      heartbeat: null,
      ageMs: null,
      error: error instanceof Error ? error.message : "Worker check failed",
    })),
  ]);

  const healthy =
    database.status === "ok" &&
    redis.status === "ok" &&
    queue.status === "ok" &&
    worker.healthy;

  const body = detailed
    ? {
        status: healthy ? "ok" : "degraded",
        checks: { database, redis, queue, worker },
        // Only for the operator. A tenant never sees this.
        fleet: await fleetSignals().catch(() => null),
      }
    : {
        status: healthy ? "ok" : "degraded",
        checks: {
          database: database.status,
          redis: redis.status,
          queue: queue.status,
          // Whether the worker is alive is the one operational fact an uptime
          // monitor genuinely needs. Its pid, hostname and start time are not.
          worker: worker.healthy ? "ok" : "error",
        },
      };

  return NextResponse.json(body, { status: healthy ? 200 : 503 });
}
