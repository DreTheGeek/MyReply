import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db/client";
import { enqueueWebhookDelivery } from "./queue";

/**
 * The events a partner app or a workspace can subscribe to, and the one
 * function that emits them.
 *
 * Emitting never fails the thing that happened. A comment that arrived has
 * arrived, whether or not the partner hears about it, so a failure here is
 * logged and the caller carries on.
 *
 * An event emitted twice for the same happening (a platform redelivering its
 * webhook, a job retrying) carries the same id, because the id is derived from
 * what happened rather than drawn at random. Each endpoint gets it once.
 */

export const WEBHOOK_EVENTS = [
  "comment.received",
  "dm.received",
  "dm.sent",
  "dm.failed",
  "contact.captured",
  "account.connected",
  "account.disconnected",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_COPY: Record<WebhookEventType, string> = {
  "comment.received": "Someone commented on a connected account's post.",
  "dm.received": "Someone sent a connected account a message.",
  "dm.sent": "A message was sent, by a campaign, the inbox or the API.",
  "dm.failed": "A message could not be sent, or the platform did not confirm it.",
  "contact.captured": "Someone shared their email or phone number, with the consent wording they saw.",
  "account.connected": "An account was connected or reconnected.",
  "account.disconnected": "An account was disconnected, removed on the platform, or deleted at the person's request.",
};

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

export interface EmitInput {
  workspaceId: string;
  type: WebhookEventType;
  data: Record<string, unknown>;
  /**
   * What makes this happening unique, such as the platform's comment id. The
   * same key gives the same event id, so a repeat is delivered once. Left out,
   * every call is a new event.
   */
  dedupeKey?: string;
  at?: Date;
}

export function eventIdFor(input: Pick<EmitInput, "workspaceId" | "type" | "dedupeKey">): string {
  if (!input.dedupeKey) return `evt_${randomBytes(16).toString("hex")}`;
  const digest = createHash("sha256")
    .update(`${input.workspaceId}\n${input.type}\n${input.dedupeKey}`)
    .digest("hex");
  return `evt_${digest.slice(0, 32)}`;
}

/** Delivery ids are derived too, so a repeated emit cannot make a second row. */
export function deliveryIdFor(eventId: string, endpointId: string): string {
  return `whd_${createHash("sha256").update(`${eventId}\n${endpointId}`).digest("hex").slice(0, 32)}`;
}

export async function emitEvent(input: EmitInput): Promise<void> {
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { id: true, partnerId: true, externalId: true },
    });
    if (!workspace) return;

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: {
        disabledAt: null,
        events: { has: input.type },
        OR: [
          { workspaceId: workspace.id },
          ...(workspace.partnerId ? [{ partnerId: workspace.partnerId }] : []),
        ],
      },
      select: { id: true },
    });
    if (endpoints.length === 0) return;

    const eventId = eventIdFor(input);
    const payload = JSON.stringify({
      id: eventId,
      type: input.type,
      createdAt: (input.at ?? new Date()).toISOString(),
      workspace: { id: workspace.id, externalId: workspace.externalId },
      data: input.data,
    });

    const rows = endpoints.map((endpoint) => ({
      id: deliveryIdFor(eventId, endpoint.id),
      endpointId: endpoint.id,
      eventId,
      eventType: input.type,
      workspaceId: workspace.id,
      payload,
    }));
    await prisma.webhookDelivery.createMany({ data: rows, skipDuplicates: true });

    // Queued by delivery id, so a repeat is also ignored by the queue, and the
    // worker skips anything already delivered.
    for (const row of rows) await enqueueWebhookDelivery(row.id);
  } catch (error) {
    console.error("[webhooks] Could not emit an event:", {
      workspaceId: input.workspaceId,
      type: input.type,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
    });
  }
}
