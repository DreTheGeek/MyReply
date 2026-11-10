import { z } from "zod";
import { releaseWorkspaceDMReservation, reserveWorkspaceDMSend } from "@/lib/billing/usage";
import { getChannelCapabilities } from "@/lib/channels/capabilities";
import { getChannelAdapter, openChannel } from "@/lib/channels/registry";
import { messagingWindow } from "@/lib/channels/windows";
import { prisma } from "@/lib/db/client";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";

/**
 * A message sent by a program through the API.
 *
 * A program is automation, so it gets automation's rules and none of a
 * person's: only inside the standard window after the person last wrote,
 * tapped or arrived through a link, never under the human-agent tag, never to
 * someone with no recorded conversation, and never to someone who said stop.
 * It reserves the same workspace budget and per-account hourly slot the
 * worker does, so the API cannot spend the account's platform limit behind
 * the worker's back.
 */

export const apiSendSchema = z
  .object({
    accountId: z.string().min(1).max(100),
    recipientId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(1000),
  })
  .strict();

export type ApiSendResult =
  /**
   * "unconfirmed": the platform's answer was ambiguous and the message may
   * have arrived. It is a success-shaped answer on purpose, so the
   * idempotency record keeps it and a retry is told the same thing rather
   * than sending a second copy.
   */
  | { ok: true; status: "sent" | "unconfirmed"; messageId: string | null; recipientId: string | null }
  | { ok: false; status: number; error: string };

export async function sendApiMessage(
  workspaceId: string,
  input: z.infer<typeof apiSendSchema>,
  now: Date = new Date()
): Promise<ApiSendResult> {
  const account = await prisma.instagramAccount.findFirst({
    where: { id: input.accountId, workspaceId },
  });
  if (!account) return { ok: false, status: 404, error: "That account is not connected to this workspace." };

  const contact = await prisma.contact.findUnique({
    where: { instagramAccountId_externalId: { instagramAccountId: account.id, externalId: input.recipientId } },
    select: { lastInboundAt: true, optedOutAt: true },
  });
  if (contact?.optedOutAt) {
    return { ok: false, status: 409, error: "This person asked not to be messaged." };
  }

  const window = messagingWindow({
    capabilities: getChannelCapabilities(account.platform),
    lastInboundAt: contact?.lastInboundAt ?? null,
    now,
    sender: "automation",
  });
  if (!window.allowed) {
    return {
      ok: false,
      status: 409,
      error: "The messaging window is closed. This person has to message the account before it can write to them.",
    };
  }

  const usage = await reserveWorkspaceDMSend(workspaceId);
  if (!usage.allowed) {
    return { ok: false, status: 429, error: "This workspace has used its message allowance for the period." };
  }
  const slot = await reserveDMSlot(account.instagramId).catch(() => null);
  if (!slot || !slot.allowed) {
    await releaseWorkspaceDMReservation(workspaceId, usage.periodStart);
    return { ok: false, status: 429, error: "This account has reached its hourly message limit. Try again later." };
  }

  try {
    const channel = await openChannel(account, { source: "api" });
    const receipt = await channel.adapter.messaging.send(channel.context, {
      to: { kind: "user", userId: input.recipientId },
      content: { kind: "text", text: input.text },
    });
    return {
      ok: true,
      status: "sent",
      messageId: receipt.messageId ?? null,
      recipientId: receipt.recipientId ?? null,
    };
  } catch (error) {
    const adapter = getChannelAdapter(account.platform);
    // A refusal did not arrive, so the budget goes back. An ambiguous answer
    // may have arrived, so it is kept, exactly as the worker does.
    const confirmed = adapter.errors.isConfirmedRejection(error);
    if (confirmed) await releaseWorkspaceDMReservation(workspaceId, usage.periodStart);
    console.error("[API send] Send failed:", error instanceof Error ? error.name : "unknown");
    return confirmed
      ? { ok: false, status: 422, error: adapter.errors.userMessage(error) ?? "The platform refused the message." }
      : { ok: true, status: "unconfirmed", messageId: null, recipientId: input.recipientId };
  }
}
