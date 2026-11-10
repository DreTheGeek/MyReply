import { Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { decryptToken } from "@/lib/security/token-crypto";
import { postWebhook, type PostFetch } from "./send";
import { webhookHeaders } from "./signing";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_QUEUE_NAME,
  webhookRetryDelay,
  type WebhookDeliveryJob,
} from "./queue";

/**
 * Deliver one event to one endpoint, once per attempt, and write down what
 * happened. A failure throws so the queue retries with backoff; the last
 * failure marks the delivery FAILED and counts against the endpoint.
 *
 * The signing timestamp is taken fresh on each attempt, so a delivery retried
 * hours later still passes the receiver's five minute check, while the
 * webhook-id stays the event id so the receiver can drop a repeat.
 */

export class WebhookDeliveryRetry extends Error {
  constructor(reason: string) {
    super(`Webhook delivery failed: ${reason}`);
    this.name = "WebhookDeliveryRetry";
  }
}

export type DeliveryOutcome = "delivered" | "retrying" | "failed" | "skipped";

export async function attemptDelivery(
  deliveryId: string,
  attemptNumber: number,
  options: { fetchImpl?: PostFetch; resolve?: (host: string) => Promise<string[]>; now?: () => Date } = {}
): Promise<DeliveryOutcome> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true,
      eventId: true,
      payload: true,
      status: true,
      endpoint: { select: { id: true, url: true, secretEncrypted: true, disabledAt: true } },
    },
  });
  // Gone (the endpoint or workspace was deleted), already delivered, or the
  // endpoint was switched off: nothing to do, and nothing to retry.
  if (!delivery || delivery.status === "DELIVERED" || delivery.endpoint.disabledAt) return "skipped";

  const now = options.now ?? (() => new Date());
  const secret = decryptToken(delivery.endpoint.secretEncrypted);
  const timestamp = Math.floor(now().getTime() / 1000);
  const result = await postWebhook(
    delivery.endpoint.url,
    webhookHeaders(secret, delivery.eventId, timestamp, delivery.payload),
    delivery.payload,
    { fetchImpl: options.fetchImpl, resolve: options.resolve }
  );

  if (result.ok) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "DELIVERED",
          attempts: attemptNumber,
          lastStatusCode: result.status,
          lastError: null,
          lastAttemptAt: now(),
          deliveredAt: now(),
        },
      }),
      prisma.webhookEndpoint.update({
        where: { id: delivery.endpoint.id },
        data: { consecutiveFailures: 0 },
      }),
    ]);
    return "delivered";
  }

  const final = attemptNumber >= WEBHOOK_MAX_ATTEMPTS;
  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: final ? "FAILED" : "PENDING",
      attempts: attemptNumber,
      lastStatusCode: result.status,
      lastError: result.reason.slice(0, 200),
      lastAttemptAt: now(),
    },
  });
  if (final) {
    await prisma.webhookEndpoint.update({
      where: { id: delivery.endpoint.id },
      data: { consecutiveFailures: { increment: 1 } },
    });
    return "failed";
  }
  throw new WebhookDeliveryRetry(result.reason);
}

async function processDelivery(job: Job<WebhookDeliveryJob>): Promise<void> {
  // attemptsMade counts finished attempts, so this one is the next.
  await attemptDelivery(job.data.deliveryId, job.attemptsMade + 1);
}

export function createWebhookWorker(): Worker<WebhookDeliveryJob> {
  const worker = new Worker<WebhookDeliveryJob>(WEBHOOK_QUEUE_NAME, processDelivery, {
    connection: getRedisConnection(),
    concurrency: 5,
    settings: {
      backoffStrategy: (attemptsMade: number) => webhookRetryDelay(attemptsMade),
    },
  });
  worker.on("failed", (job, error) => {
    if (error instanceof WebhookDeliveryRetry) return;
    console.error("[webhooks] Delivery job broke:", {
      deliveryId: job?.data.deliveryId,
      reason: `${error.name}: ${error.message}`,
    });
  });
  return worker;
}
