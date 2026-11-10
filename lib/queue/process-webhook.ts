import { prisma } from "@/lib/db/client";
import { applyOptOut } from "@/lib/messaging/apply-opt-out";
import { detectOptOutIntent } from "@/lib/messaging/opt-out";
import {
  getDMQueue,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
} from "@/lib/queue/client";
import {
  parseCommentEvents,
  parseLiveCommentEvents,
  parseMentionEvents,
  parseMessageEchoEvents,
  parseMessageEditEvents,
  parseMessageEvents,
  parsePostbackEvents,
  parseReactionEvents,
  parseReadEvents,
  parseReferralEvents,
  type WebhookMentionEvent,
  type WebhookMessageEchoEvent,
  type WebhookReactionEvent,
} from "@/lib/meta/webhook";
import {
  recordContactReaction,
  recordOutboundMessageSeen,
  upsertContact,
} from "@/lib/contacts";
import { Prisma, type InstagramProvider } from "@/app/generated/prisma/client";

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;

/**
 * How close in time a SENT DmLog row has to be for an echo to be read as
 * MyReply's own send rather than a human's reply.
 *
 * Instagram echoes an outbound message back within seconds, so the window is
 * deliberately tight. Widening it would start attributing an operator's own
 * typing to whichever campaign happened to fire recently. See the caveat in
 * recordOutboundEcho about the send path not storing the mid it was given.
 */
const ECHO_ATTRIBUTION_WINDOW_MS = 2 * 60 * 1000;

type InstagramPayload = Parameters<typeof parseCommentEvents>[0];

interface ResolvedAccount {
  /** InstagramAccount.id, the connection row. */
  id: string;
  instagramId: string;
  workspaceId: string;
}

/**
 * How a handler looks up the account an event belongs to. Every account in a
 * payload is loaded once up front, so this is a map read, never a query.
 */
type AccountResolver = (instagramId: string) => ResolvedAccount | null;

/**
 * Record a message the connected account sent, as echoed back by Instagram.
 *
 * Two things this must not do:
 *
 * 1. Duplicate a message MyReply itself sent. The row is keyed on Meta's mid,
 *    so a redelivered webhook can never write a second row, and an echo that
 *    lines up with a recent SENT DmLog row is stored as AUTOMATION and linked
 *    back to that row rather than presented as a separate reply. Only a
 *    genuinely manual message moves Contact.dmCount, which the send path
 *    already moved for MyReply's own DMs.
 * 2. Trigger anything. Nothing here enqueues a job. Echoes are recorded, never
 *    acted on, which is also why parseMessageEvents still drops them.
 *
 * Attribution is by recipient and time because MyReply does not store the
 * message id Meta returns from a send. If it ever does, this becomes an exact
 * match on that id and the window can go away.
 */
async function recordOutboundEcho(
  event: WebhookMessageEchoEvent,
  resolve: AccountResolver
): Promise<string | null> {
  const account = resolve(event.instagramAccountId);
  if (!account) return null;

  // Already recorded. Meta redelivers webhooks, and re-running the counters
  // for a message we have seen is exactly the duplicate to avoid.
  const existing = await prisma.outboundMessage.findUnique({
    where: { messageId: event.messageId },
    select: { id: true },
  });
  if (existing) return account.workspaceId;

  const sentAt = event.sentAt ?? new Date();

  const dmLog = await prisma.dmLog.findFirst({
    where: {
      instagramAccountId: account.id,
      commenterId: event.recipientId,
      status: "SENT",
      dmSentAt: {
        gte: new Date(sentAt.getTime() - ECHO_ATTRIBUTION_WINDOW_MS),
        lte: new Date(sentAt.getTime() + ECHO_ATTRIBUTION_WINDOW_MS),
      },
    },
    orderBy: { dmSentAt: "desc" },
    select: { id: true },
  });

  const contact = await upsertContact({
    workspaceId: account.workspaceId,
    instagramAccountId: account.id,
    externalId: event.recipientId,
  });

  try {
    await prisma.outboundMessage.create({
      data: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        contactId: contact?.id ?? null,
        recipientId: event.recipientId,
        messageId: event.messageId,
        text: event.messageText,
        source: dmLog ? "AUTOMATION" : "MANUAL",
        dmLogId: dmLog?.id ?? null,
        sentAt,
      },
    });
  } catch {
    // The unique index on messageId is the backstop for two deliveries racing.
    // Losing that race means the message is already recorded, so stop here
    // rather than counting it a second time.
    return account.workspaceId;
  }

  if (contact) {
    await recordOutboundMessageSeen({
      contactId: contact.id,
      sentAt,
      countTowardsDmTotal: !dmLog,
    });
  }

  return account.workspaceId;
}

/**
 * Record a reaction on a delivered message against the contact who placed it.
 *
 * Only "react" gets here. An "unreact" is filtered out by the caller, because
 * it is the withdrawal of a positive signal and recording it as one would make
 * every segment built on this counter wrong.
 */
async function recordReaction(
  event: WebhookReactionEvent,
  resolve: AccountResolver
): Promise<string | null> {
  const account = resolve(event.instagramAccountId);
  if (!account) return null;

  const contact = await upsertContact({
    workspaceId: account.workspaceId,
    instagramAccountId: account.id,
    externalId: event.userId,
  });
  if (contact) {
    await recordContactReaction(contact.id, new Date());
  }

  return account.workspaceId;
}

/**
 * Record a mention of the account and make it visible to an operator.
 *
 * Deliberately not wired to any DM send. A mention is a second acquisition
 * surface and what to do about one is a product decision that has not been
 * made, so this logs it and stops. The contact is upserted only when Meta
 * named the author, which many mention payloads do not.
 */
async function recordMention(
  event: WebhookMentionEvent,
  resolve: AccountResolver
): Promise<string | null> {
  const account = resolve(event.instagramAccountId);

  if (account && event.mentionerId) {
    await upsertContact({
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      externalId: event.mentionerId,
      username: event.mentionerName ?? null,
    });
  }

  await prisma.operationalEvent.create({
    data: {
      workspaceId: account?.workspaceId ?? null,
      source: "SYSTEM",
      level: "INFO",
      message:
        event.surface === "comment"
          ? "Instagram comment mention received"
          : "Instagram caption mention received",
      payload: {
        instagramAccountId: event.instagramAccountId,
        mediaId: event.mediaId,
        commentId: event.commentId ?? null,
        mentionerId: event.mentionerId ?? null,
        mentionerName: event.mentionerName ?? null,
        surface: event.surface,
        // Which of Meta's two documented shapes actually arrived, so a
        // disagreement between their docs is answerable from our own data.
        deliveredOn: event.deliveredOn,
      },
    },
  });

  return account?.workspaceId ?? null;
}

/**
 * Turn one verified Instagram webhook payload into queued work.
 *
 * Shared by every way an Instagram event can arrive: Meta's own webhook, and
 * any provider that relays Meta-shaped payloads. Only entries for accounts
 * connected through `provider` (and, when given, inside `workspaceId`) are
 * kept, so a relay for one workspace can never enqueue work for another, and
 * a payload naming no known account writes nothing at all.
 *
 * Throws after marking the WebhookEvent FAILED, so the caller can answer
 * non-2xx and the sender retries. Every job id below is deterministic, which
 * is what makes that retry safe.
 */
export async function processInstagramWebhook({
  payload: incoming,
  provider,
  workspaceId,
}: {
  payload: InstagramPayload;
  provider: InstagramProvider;
  workspaceId?: string;
}): Promise<void> {
  if (incoming.object !== "instagram" || !Array.isArray(incoming.entry)) return;

  const accounts = await prisma.instagramAccount.findMany({
    where: {
      instagramId: { in: incoming.entry.map((entry) => entry.id) },
      provider,
      ...(workspaceId ? { workspaceId } : {}),
    },
    select: { id: true, instagramId: true, workspaceId: true },
  });
  const accountMap = new Map<string, ResolvedAccount>(
    accounts.map((account) => [account.instagramId, account])
  );
  const resolve: AccountResolver = (instagramId) =>
    accountMap.get(instagramId) ?? null;

  const payload: InstagramPayload = {
    ...incoming,
    entry: incoming.entry.filter((entry) => accountMap.has(entry.id)),
  };
  if (!payload.entry.length) return;

  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object: String(payload.object),
      payload: payload as unknown as Prisma.InputJsonValue,
      ...(workspaceId ? { workspaceId } : {}),
      status: "PENDING",
    },
  });

  // The row starts with no workspace when none was given, because the tenant
  // is not known until an event has been parsed. Every later event in the same
  // batch resolves to the same one, so this writes at most once.
  let backfilledWorkspaceId: string | null = workspaceId ?? null;

  async function backfillWorkspace(id: string): Promise<void> {
    if (backfilledWorkspaceId === id) return;
    backfilledWorkspaceId = id;
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { workspaceId: id },
    });
  }

  try {
    const queue = getDMQueue();

    const commentEvents = parseCommentEvents(payload);
    for (const event of commentEvents) {
      const account = resolve(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        "process-comment",
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: account.id,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          originalMediaId: event.originalMediaId,
          source: "WEBHOOK",
        },
        { jobId: `comment_${event.instagramAccountId}_${event.commentId}` }
      );
      await backfillWorkspace(account.workspaceId);
    }

    // Comments on a Live broadcast. Same shape as a feed comment once parsed,
    // so they ride the same job and the same worker path.
    const liveCommentEvents = parseLiveCommentEvents(payload);
    for (const event of liveCommentEvents) {
      const account = resolve(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        "process-comment",
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: account.id,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          source: "LIVE",
        },
        { jobId: `live_${event.instagramAccountId}_${event.commentId}` }
      );
      await backfillWorkspace(account.workspaceId);
    }

    // Arrivals carrying a ref from a link, QR code or website button. The ref
    // names the campaign, so this needs no keyword match.
    const referralEvents = parseReferralEvents(payload);
    for (const event of referralEvents) {
      const account = resolve(event.instagramAccountId);
      if (!account) continue;

      const automation = await prisma.automation.findFirst({
        where: {
          referralRef: event.ref,
          isActive: true,
          instagramAccountId: account.id,
        },
        select: { id: true },
      });

      // An unknown ref is not an error. It usually means a campaign was paused
      // or renamed while its QR codes are still in the wild.
      if (!automation) continue;

      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: account.id,
          userId: event.userId,
          payload: `reveal:${automation.id}`,
        },
        {
          jobId: `referral_${event.instagramAccountId}_${event.userId}_${automation.id}`,
        }
      );
      await backfillWorkspace(account.workspaceId);
    }

    // Button taps from opening DMs, which deliver the reveal message.
    const postbackEvents = parsePostbackEvents(payload);
    for (const event of postbackEvents) {
      const account = resolve(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: account.id,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
        },
        {
          // BullMQ forbids ":" in custom job ids, and the payload is
          // "reveal:<id>", so build with underscores and strip any colons.
          jobId: `postback_${event.instagramAccountId}_${event.userId}_${(
            event.mid ?? event.payload
          ).replace(/:/g, "_")}`,
        }
      );
      await backfillWorkspace(account.workspaceId);
    }

    // Inbound DMs, for keyword-triggered replies.
    const messageEvents = parseMessageEvents(payload);
    for (const event of messageEvents) {
      const account = resolve(event.instagramAccountId);
      if (!account) continue;

      // Someone telling us to stop is the highest priority thing an inbound
      // message can be, so it is handled here, before the message is queued
      // for anything else. Recorded even when the reply is also a keyword
      // match: "stop" is not a campaign trigger.
      const intent = detectOptOutIntent(event.messageText);
      if (intent) {
        await applyOptOut({
          instagramAccountId: account.id,
          workspaceId: account.workspaceId,
          externalId: event.senderId,
          optOut: intent === "opt_out",
        });
        // An opt-out is not a message to reply to. Queuing it would let a
        // campaign answer "STOP" with a marketing DM, which is the exact
        // outcome the person just asked to avoid.
        if (intent === "opt_out") {
          await backfillWorkspace(account.workspaceId);
          continue;
        }
      }

      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: account.id,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
          kind: event.kind,
          quickReplyPayload: event.quickReplyPayload,
        },
        {
          // Message ids can contain characters BullMQ rejects in a job id (":"
          // in particular). base64url encodes into exactly the allowed
          // alphabet and stays injective. Substituting invalid characters
          // would let two distinct mids collapse onto one job id, silently
          // dropping a reply.
          jobId: `message_${event.instagramAccountId}_${Buffer.from(
            event.messageId
          ).toString("base64url")}`,
        }
      );
      await backfillWorkspace(account.workspaceId);
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    const readEvents = parseReadEvents(payload);
    for (const event of readEvents) {
      const account = resolve(event.instagramAccountId);
      if (!account) continue;

      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          instagramAccountId: account.id,
          automation: { isActive: true, openingDmEnabled: true },
        },
        select: { automation: { select: { id: true } } },
        // A contact who has been messaged by many campaigns would otherwise
        // pull every one of those rows on a single read receipt.
        take: 50,
      });

      const scheduledAutomationIds = new Set<string>();
      for (const log of openingLogs) {
        const automation = log.automation;
        if (scheduledAutomationIds.has(automation.id)) continue;
        scheduledAutomationIds.add(automation.id);

        await queue.add(
          POSTBACK_JOB_NAME,
          {
            instagramAccountId: event.instagramAccountId,
            accountConnectionId: account.id,
            userId: event.userId,
            payload: `reveal:${automation.id}`,
            fallback: true,
          },
          {
            delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
            jobId: `read_fallback_${event.instagramAccountId}_${event.userId}_${automation.id}`,
          }
        );
      }
    }

    // Corrections to messages that already arrived. The original `messages`
    // event fired on the typo and matched nothing, so the fixed text has to be
    // put back through campaign matching or the correction is invisible.
    //
    // The mid is unchanged, which is what keeps this safe: the worker keys its
    // DmLog row on `dm:<mid>` and skips a message it has already answered, so
    // editing a message that already triggered a DM cannot produce a second
    // one. The BullMQ job id, on the other hand, MUST differ from the original
    // message's, or BullMQ would treat the edit as a duplicate job and drop it
    // silently. num_edit makes each correction its own job while still
    // deduping a redelivery of the same correction.
    const messageEditEvents = parseMessageEditEvents(payload);
    for (const event of messageEditEvents) {
      const account = resolve(event.instagramAccountId);
      if (!account) continue;
      await backfillWorkspace(account.workspaceId);

      // Editing a message must never earn a second DM. The worker's own
      // per-campaign guard stops the campaign that already replied, but it
      // would not stop a DIFFERENT campaign that the corrected text now
      // matches, so the question is asked once here for the whole message: has
      // anything already answered this mid? The key is the worker's
      // `dm:<messageId>` DmLog key.
      const alreadyAnswered = await prisma.dmLog.findFirst({
        where: {
          instagramAccountId: account.id,
          commentId: `dm:${event.messageId}`,
          status: "SENT",
        },
        select: { id: true },
      });
      if (alreadyAnswered) continue;

      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: account.id,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
          kind: "dm",
        },
        {
          jobId: `message_edit_${event.instagramAccountId}_${Buffer.from(
            event.messageId
          ).toString("base64url")}_${event.numEdit}`,
        }
      );
    }

    // Messages the account itself sent, including ones a human typed into the
    // Instagram app. Recorded so the conversation history reflects reality.
    // Nothing is enqueued here on purpose: an echo must never run automation.
    const echoEvents = parseMessageEchoEvents(payload);
    for (const event of echoEvents) {
      const id = await recordOutboundEcho(event, resolve);
      if (id) await backfillWorkspace(id);
    }

    // Reactions on messages we delivered. A positive engagement signal worth
    // keeping for segmentation; an unreact is its withdrawal, so it is dropped
    // rather than recorded as engagement.
    const reactionEvents = parseReactionEvents(payload);
    for (const event of reactionEvents) {
      if (event.action !== "react") continue;
      const id = await recordReaction(event, resolve);
      if (id) await backfillWorkspace(id);
    }

    // Mentions of the account, in someone's caption or in a comment elsewhere.
    // Recorded and surfaced only. Wiring this to an automatic DM is a product
    // decision that has not been made.
    const mentionEvents = parseMentionEvents(payload);
    for (const event of mentionEvents) {
      const id = await recordMention(event, resolve);
      if (id) await backfillWorkspace(id);
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: message,
        processedAt: new Date(),
      },
    });
    throw error;
  }
}
