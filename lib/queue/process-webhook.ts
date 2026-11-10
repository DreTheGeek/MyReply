import { prisma } from "@/lib/db/client";
import { applyOptOut } from "@/lib/messaging/apply-opt-out";
import { detectOptOutIntent } from "@/lib/messaging/opt-out";
import {
  getDMQueue,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
} from "@/lib/queue/client";
import {
  recordContactReaction,
  recordOutboundMessageSeen,
  upsertContact,
} from "@/lib/contacts";
import type { ChannelAdapter } from "@/lib/channels/adapter";
import type {
  EchoEvent,
  MentionEvent,
  ReactionEvent,
} from "@/lib/channels/events";
import { Prisma } from "@/app/generated/prisma/client";
import { emitEvent } from "@/lib/webhooks/events";

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;

/**
 * How close in time a SENT DmLog row has to be for an echo to be read as
 * MyReply's own send rather than a human's reply.
 *
 * The platform echoes an outbound message back within seconds, so the window
 * is deliberately tight. Widening it would start attributing an operator's own
 * typing to whichever campaign happened to fire recently. See the caveat in
 * recordOutboundEcho about the send path not storing the mid it was given.
 */
const ECHO_ATTRIBUTION_WINDOW_MS = 2 * 60 * 1000;

interface ResolvedAccount {
  /** InstagramAccount.id, the connection row. */
  id: string;
  /** The platform's id for the account. */
  instagramId: string;
  workspaceId: string;
}

/**
 * How a handler looks up the account an event belongs to. Every account in a
 * payload is loaded once up front, so this is a map read, never a query.
 */
type AccountResolver = (externalId: string) => ResolvedAccount | null;

/**
 * Record a message the connected account sent, as echoed back.
 *
 * Two things this must not do:
 *
 * 1. Duplicate a message MyReply itself sent. The row is keyed on the
 *    platform's mid, so a redelivered webhook can never write a second row,
 *    and an echo that lines up with a recent SENT DmLog row is stored as
 *    AUTOMATION and linked back to that row rather than presented as a
 *    separate reply. Only a genuinely manual message moves Contact.dmCount,
 *    which the send path already moved for MyReply's own DMs.
 * 2. Trigger anything. Nothing here enqueues a job. Echoes are recorded, never
 *    acted on.
 *
 * Attribution is by recipient and time because MyReply does not store the
 * message id the platform returns from a send. If it ever does, this becomes
 * an exact match on that id and the window can go away.
 */
async function recordOutboundEcho(
  event: EchoEvent,
  resolve: AccountResolver
): Promise<string | null> {
  const account = resolve(event.accountExternalId);
  if (!account) return null;

  // Already recorded. Platforms redeliver webhooks, and re-running the
  // counters for a message we have seen is exactly the duplicate to avoid.
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
        text: event.text,
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
  event: ReactionEvent,
  resolve: AccountResolver
): Promise<string | null> {
  const account = resolve(event.accountExternalId);
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
 * made, so this logs it and stops. The contact is upserted only when the
 * platform named the author, which many mention payloads do not.
 */
async function recordMention(
  event: MentionEvent,
  resolve: AccountResolver
): Promise<string | null> {
  const account = resolve(event.accountExternalId);

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
        instagramAccountId: event.accountExternalId,
        mediaId: event.mediaId,
        commentId: event.commentId ?? null,
        mentionerId: event.mentionerId ?? null,
        mentionerName: event.mentionerName ?? null,
        surface: event.surface,
        // Which of the platform's documented shapes actually arrived, so a
        // disagreement between their docs is answerable from our own data.
        deliveredOn: event.deliveredOn,
      },
    },
  });

  return account?.workspaceId ?? null;
}

/**
 * Turn one verified webhook payload into queued work.
 *
 * The adapter parses the payload into channel events; everything here reads
 * only those. Only events for accounts connected on the adapter's platform
 * (and, when given, inside `workspaceId`) are kept, so a payload naming no
 * known account writes nothing at all and a caller scoped to one workspace
 * can never enqueue work for another.
 *
 * Throws after marking the WebhookEvent FAILED, so the caller can answer
 * non-2xx and the sender retries. Every job id below is deterministic, which
 * is what makes that retry safe.
 */
export async function processChannelWebhook({
  adapter,
  payload,
  workspaceId,
}: {
  adapter: ChannelAdapter;
  payload: unknown;
  workspaceId?: string;
}): Promise<void> {
  const events = adapter.webhook.parse(payload);
  if (events.length === 0) return;

  const externalIds = [...new Set(events.map((event) => event.accountExternalId))];
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      instagramId: { in: externalIds },
      platform: adapter.platform,
      ...(workspaceId ? { workspaceId } : {}),
    },
    select: { id: true, instagramId: true, workspaceId: true },
  });
  const accountMap = new Map<string, ResolvedAccount>(
    accounts.map((account) => [account.instagramId, account])
  );
  const resolve: AccountResolver = (externalId) =>
    accountMap.get(externalId) ?? null;

  const known = events.filter((event) => accountMap.has(event.accountExternalId));
  if (known.length === 0) return;

  const stored = adapter.webhook.scopePayload(payload, new Set(accountMap.keys()));
  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object:
        typeof stored === "object" && stored !== null && "object" in stored
          ? String((stored as { object: unknown }).object)
          : null,
      payload: stored as Prisma.InputJsonValue,
      ...(workspaceId ? { workspaceId } : {}),
      status: "PENDING",
    },
  });

  // The row starts with no workspace when none was given, because the tenant
  // is not known until an event has been resolved. Every later event in the
  // same batch resolves to the same one, so this writes at most once.
  let backfilledWorkspaceId: string | null = workspaceId ?? null;

  async function backfillWorkspace(id: string): Promise<void> {
    if (backfilledWorkspaceId === id) return;
    backfilledWorkspaceId = id;
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { workspaceId: id },
    });
  }

  /**
   * Record that a person reached out, which opens the platform's messaging
   * window. Done before any job is queued, so the worker's window check reads
   * a value that already includes this event.
   */
  async function markInbound(account: ResolvedAccount, externalId: string): Promise<void> {
    await upsertContact({
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      externalId,
      inboundAt: receivedAt,
    });
  }

  const receivedAt = new Date();

  try {
    const queue = getDMQueue();

    // One pass, in the order the adapter returned them, which is the order
    // they have always been handled in.
    for (const event of known) {
      const account = resolve(event.accountExternalId);
      if (!account) continue;

      switch (event.type) {
        case "comment": {
          const live = event.surface === "live";
          await queue.add(
            "process-comment",
            {
              instagramAccountId: event.accountExternalId,
              accountConnectionId: account.id,
              commentId: event.commentId,
              commentText: event.text,
              commenterId: event.authorId,
              commenterName: event.authorName,
              mediaId: event.mediaId,
              ...(live ? {} : { originalMediaId: event.originalMediaId }),
              ...(event.createdAt
                ? { commentCreatedAt: event.createdAt.toISOString() }
                : {}),
              source: live ? "LIVE" : "WEBHOOK",
            },
            {
              jobId: `${live ? "live" : "comment"}_${event.accountExternalId}_${event.commentId}`,
            }
          );
          await backfillWorkspace(account.workspaceId);
          break;
        }

        // Arrivals carrying a ref from a link, QR code or website button. The
        // ref names the campaign, so this needs no keyword match.
        case "referral": {
          const automation = await prisma.automation.findFirst({
            where: {
              referralRef: event.ref,
              isActive: true,
              instagramAccountId: account.id,
            },
            select: { id: true },
          });

          // Arriving through a link opens the window whether or not the ref
          // still names a live campaign.
          await markInbound(account, event.userId);

          // An unknown ref is not an error. It usually means a campaign was
          // paused or renamed while its QR codes are still in the wild.
          if (!automation) break;

          await queue.add(
            POSTBACK_JOB_NAME,
            {
              instagramAccountId: event.accountExternalId,
              accountConnectionId: account.id,
              userId: event.userId,
              payload: `reveal:${automation.id}`,
              receivedAt: receivedAt.toISOString(),
            },
            {
              jobId: `referral_${event.accountExternalId}_${event.userId}_${automation.id}`,
            }
          );
          await backfillWorkspace(account.workspaceId);
          break;
        }

        // Button taps from opening DMs, which deliver the reveal message.
        case "postback": {
          await markInbound(account, event.userId);
          await queue.add(
            POSTBACK_JOB_NAME,
            {
              instagramAccountId: event.accountExternalId,
              accountConnectionId: account.id,
              userId: event.userId,
              payload: event.payload,
              mid: event.mid,
              receivedAt: receivedAt.toISOString(),
            },
            {
              // BullMQ forbids ":" in custom job ids, and the payload is
              // "reveal:<id>", so build with underscores and strip any colons.
              jobId: `postback_${event.accountExternalId}_${event.userId}_${(
                event.mid ?? event.payload
              ).replace(/:/g, "_")}`,
            }
          );
          await backfillWorkspace(account.workspaceId);
          break;
        }

        // Inbound DMs, for keyword-triggered replies.
        case "message": {
          // Someone telling us to stop is the highest priority thing an
          // inbound message can be, so it is handled here, before the message
          // is queued for anything else. Recorded even when the reply is also
          // a keyword match: "stop" is not a campaign trigger.
          await markInbound(account, event.senderId);
          const intent = detectOptOutIntent(event.text);
          // Every inbound message, an opt-out included, is told to listening
          // partner apps, so their copy of the conversation is complete.
          await emitEvent({
            workspaceId: account.workspaceId,
            type: "dm.received",
            dedupeKey: `${account.id}:${event.messageId}`,
            at: receivedAt,
            data: {
              account: { id: account.id, platform: adapter.platform },
              sender: { id: event.senderId },
              message: {
                id: event.messageId,
                text: event.text,
                kind: event.kind,
                ...(event.quickReplyPayload ? { quickReplyPayload: event.quickReplyPayload } : {}),
              },
              optOut: intent === "opt_out",
            },
          });
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
              break;
            }
          }

          await queue.add(
            MESSAGE_JOB_NAME,
            {
              instagramAccountId: event.accountExternalId,
              accountConnectionId: account.id,
              messageId: event.messageId,
              messageText: event.text,
              senderId: event.senderId,
              kind: event.kind,
              quickReplyPayload: event.quickReplyPayload,
              receivedAt: receivedAt.toISOString(),
            },
            {
              // Message ids can contain characters BullMQ rejects in a job id
              // (":" in particular). base64url encodes into exactly the allowed
              // alphabet and stays injective. Substituting invalid characters
              // would let two distinct mids collapse onto one job id, silently
              // dropping a reply.
              jobId: `message_${event.accountExternalId}_${Buffer.from(
                event.messageId
              ).toString("base64url")}`,
            }
          );
          await backfillWorkspace(account.workspaceId);
          break;
        }

        // If a user reads the opening DM and never taps the button, deliver
        // the same next-step DM after five minutes. The worker no-ops this
        // delayed job if a real button tap has already delivered the reveal.
        case "read": {
          const openingLogs = await prisma.dmLog.findMany({
            where: {
              commenterId: event.userId,
              status: "SENT",
              instagramAccountId: account.id,
              automation: { isActive: true, openingDmEnabled: true },
            },
            select: { automation: { select: { id: true } } },
            // A contact who has been messaged by many campaigns would
            // otherwise pull every one of those rows on a single read receipt.
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
                instagramAccountId: event.accountExternalId,
                accountConnectionId: account.id,
                userId: event.userId,
                payload: `reveal:${automation.id}`,
                fallback: true,
              },
              {
                delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
                jobId: `read_fallback_${event.accountExternalId}_${event.userId}_${automation.id}`,
              }
            );
          }
          break;
        }

        // Corrections to messages that already arrived. The original message
        // event fired on the typo and matched nothing, so the fixed text has
        // to be put back through campaign matching or the correction is
        // invisible.
        //
        // The mid is unchanged, which is what keeps this safe: the worker keys
        // its DmLog row on `dm:<mid>` and skips a message it has already
        // answered, so editing a message that already triggered a DM cannot
        // produce a second one. The BullMQ job id, on the other hand, MUST
        // differ from the original message's, or BullMQ would treat the edit
        // as a duplicate job and drop it silently. The edit count makes each
        // correction its own job while still deduping a redelivery of the same
        // correction.
        case "message_edit": {
          await backfillWorkspace(account.workspaceId);
          await markInbound(account, event.senderId);

          // Editing a message must never earn a second DM. The worker's own
          // per-campaign guard stops the campaign that already replied, but it
          // would not stop a DIFFERENT campaign that the corrected text now
          // matches, so the question is asked once here for the whole
          // message: has anything already answered this mid? The key is the
          // worker's `dm:<messageId>` DmLog key.
          const alreadyAnswered = await prisma.dmLog.findFirst({
            where: {
              instagramAccountId: account.id,
              commentId: `dm:${event.messageId}`,
              status: "SENT",
            },
            select: { id: true },
          });
          if (alreadyAnswered) break;

          await queue.add(
            MESSAGE_JOB_NAME,
            {
              instagramAccountId: event.accountExternalId,
              accountConnectionId: account.id,
              messageId: event.messageId,
              messageText: event.text,
              senderId: event.senderId,
              kind: "dm",
              receivedAt: receivedAt.toISOString(),
            },
            {
              jobId: `message_edit_${event.accountExternalId}_${Buffer.from(
                event.messageId
              ).toString("base64url")}_${event.editCount}`,
            }
          );
          break;
        }

        // Messages the account itself sent, including ones a human typed into
        // the platform's own app. Recorded so the conversation history
        // reflects reality. Nothing is enqueued: an echo must never run
        // automation.
        case "echo": {
          const id = await recordOutboundEcho(event, resolve);
          if (id) await backfillWorkspace(id);
          break;
        }

        // Reactions on messages we delivered. A positive engagement signal
        // worth keeping for segmentation; an unreact is its withdrawal, so it
        // is dropped rather than recorded as engagement.
        case "reaction": {
          if (event.action !== "react") break;
          const id = await recordReaction(event, resolve);
          if (id) await backfillWorkspace(id);
          break;
        }

        // Mentions of the account, in someone's caption or in a comment
        // elsewhere. Recorded and surfaced only.
        case "mention": {
          const id = await recordMention(event, resolve);
          if (id) await backfillWorkspace(id);
          break;
        }
      }
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
