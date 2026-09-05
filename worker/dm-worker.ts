import { validateCoreEnv } from "@/lib/env";
import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import os from "node:os";

// lib/env.ts has had a complete Zod schema for the nine required server
// variables since it was written, and nothing ever called it. A missing key
// surfaced as a throw deep inside a job instead of a refusal to start.
//
// The worker is the right place to enforce it: it is a long lived process with
// a real boot, unlike the serverless handlers, and every send in the product
// goes through it. Failing here is loud, immediate, and restarts cleanly once
// the variable is set.
try {
  validateCoreEnv();
} catch (error) {
  console.error(
    "[DM Worker] Refusing to start: the environment is incomplete.",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
}

const worker = createDMWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// BullMQ job failures and worker errors are already recorded. Anything thrown
// outside those paths had no handler at all, so the process died with the
// reason going only to the container's stdout as an unhandled rejection
// warning. These at least name it before the process goes.
process.on("unhandledRejection", (reason) => {
  console.error("[DM Worker] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[DM Worker] Uncaught exception:", error);
  // Deliberately fatal, and deliberately NOT through shutdown(), which exits
  // 0. railway.json sets restartPolicyType ON_FAILURE, so a zero exit would
  // read as a clean stop and the worker would never come back. Every send in
  // the product goes through this process, so it has to fail loudly enough to
  // be restarted.
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  void worker
    .close()
    .catch(() => {})
    .finally(() => process.exit(1));
});
