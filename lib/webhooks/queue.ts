import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * Webhook deliveries run on their own queue on the existing worker and Redis,
 * so a slow partner endpoint can never hold up a DM, and there is nothing new
 * to host or pay for.
 *
 * Retries back off from a minute to a day, nine attempts in all, which spans
 * about two days: long enough to ride out a partner's outage or a weekend
 * deploy freeze.
 */

export const WEBHOOK_QUEUE_NAME = "webhook-deliveries";
export const WEBHOOK_JOB_NAME = "deliver";

/** Delay before each retry, in milliseconds. */
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
  14 * 3_600_000,
  24 * 3_600_000,
] as const;

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/** The delay before retry number `attemptsMade` (1 after the first failure). */
export function webhookRetryDelay(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1), WEBHOOK_RETRY_DELAYS_MS.length) - 1;
  return WEBHOOK_RETRY_DELAYS_MS[index];
}

export interface WebhookDeliveryJob {
  deliveryId: string;
}

let queue: Queue<WebhookDeliveryJob> | null = null;

export function getWebhookQueue(): Queue<WebhookDeliveryJob> {
  queue ??= new Queue<WebhookDeliveryJob>(WEBHOOK_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: WEBHOOK_MAX_ATTEMPTS,
      backoff: { type: "custom" },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return queue;
}

export async function enqueueWebhookDelivery(deliveryId: string): Promise<void> {
  await getWebhookQueue().add(WEBHOOK_JOB_NAME, { deliveryId }, { jobId: deliveryId });
}
