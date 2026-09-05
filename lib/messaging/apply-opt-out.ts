import { prisma } from "@/lib/db/client";

/**
 * Recording that someone asked to stop, or asked to come back.
 *
 * Separate from `detectOptOutIntent` so the recognition stays a pure function
 * with no database in it, and this stays the only place that writes the flag.
 *
 * WHY UPSERT RATHER THAN UPDATE. The person may not have a Contact row yet.
 * Contacts are created when a campaign messages someone, and a webhook can
 * deliver a DM from a stranger who has never been messaged. Updating nothing
 * in that case would silently discard the opt-out, and the next campaign that
 * did reach them would message someone who had already said no.
 */
export interface ApplyOptOutInput {
  instagramAccountId: string;
  workspaceId: string;
  /** The platform-scoped sender id from the webhook. */
  externalId: string;
  /** True for STOP, false for START. */
  optOut: boolean;
}

export async function applyOptOut({
  instagramAccountId,
  workspaceId,
  externalId,
  optOut,
}: ApplyOptOutInput): Promise<void> {
  const optedOutAt = optOut ? new Date() : null;

  try {
    await prisma.contact.upsert({
      where: {
        instagramAccountId_externalId: { instagramAccountId, externalId },
      },
      create: {
        workspaceId,
        instagramAccountId,
        externalId,
        optedOutAt,
      },
      update: { optedOutAt },
    });

    // Worth a durable record: this is a person exercising a choice about
    // whether we may contact them, and "when did they opt out" is the question
    // that gets asked when someone complains.
    await prisma.operationalEvent.create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: "INFO",
        message: optOut ? "contact.opted_out" : "contact.opted_in",
        payload: { instagramAccountId, externalId },
        resolvedAt: new Date(),
      },
    });
  } catch (error) {
    // Never let this fail the webhook. Meta retries a non-200, and a retry
    // storm caused by a bookkeeping error would be worse than a missed record.
    // The console line is what reaches a human today.
    console.error("[Webhook] Could not record opt-out change", error);
  }
}
