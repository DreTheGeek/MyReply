import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
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
  verifyWebhookSignature,
  type WebhookMentionEvent,
  type WebhookMessageEchoEvent,
  type WebhookReactionEvent,
} from "@/lib/meta/webhook";
import { MESSAGE_JOB_NAME, POSTBACK_JOB_NAME } from "@/lib/queue/client";
import {
  recordContactReaction,
  recordOutboundMessageSeen,
  upsertContact,
} from "@/lib/contacts";
import { Prisma } from "@/app/generated/prisma/client";

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

interface ResolvedAccount {
  id: string;
  workspaceId: string;
}

async function resolveAccount(
  instagramId: string
): Promise<ResolvedAccount | null> {
  return prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { id: true, workspaceId: true },
  });
}

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
  event: WebhookMessageEchoEvent
): Promise<string | null> {
  const account = await resolveAccount(event.instagramAccountId);
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
  event: WebhookReactionEvent
): Promise<string | null> {
  const account = await resolveAccount(event.instagramAccountId);
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
  event: WebhookMentionEvent
): Promise<string | null> {
  const account = await resolveAccount(event.instagramAccountId);

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

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    // This is the common symptom of FACEBOOK_APP_SECRET being set to the
    // wrong app's secret for the webhook's signing key, and while it is
    // happening no comment reaches any campaign. So it has to be loud.
    //
    // The OperationalEvent below is written with no workspaceId, because at
    // this point the payload has not been parsed and no tenant is known. Every
    // read path for that table is scoped to a workspace, so nobody can ever
    // see this row: it is written for a future operator view that does not
    // exist yet. The console line is what actually reaches a human today,
    // through the platform's own log search.
    console.error(
      "[Webhook] Signature verification failed.",
      `hadSignatureHeader=${Boolean(signature)} bodyLength=${rawBody.length}.`,
      "If this repeats, FACEBOOK_APP_SECRET is probably the wrong app's secret."
    );
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "WARNING",
          message: "Webhook signature verification failed",
          payload: {
            hadSignatureHeader: Boolean(signature),
            bodyLength: rawBody.length,
            bodyPreview: rawBody.slice(0, 200),
          },
        },
      })
      // Swallowing this silently would have hidden the failure to record the
      // failure. The console line above has already gone out either way.
      .catch((error) => {
        console.error("[Webhook] Could not record the signature failure", error);
      });
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object:
        typeof payload === "object" && payload && "object" in payload
          ? String(payload.object)
          : null,
      payload: payload as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  try {
    const commentEvents = parseCommentEvents(
      payload as Parameters<typeof parseCommentEvents>[0]
    );
    const queue = getDMQueue();

    for (const event of commentEvents) {
      const account = await prisma.instagramAccount.findUnique({
        where: { instagramId: event.instagramAccountId },
        select: { workspaceId: true },
      });

      await queue.add(
        "process-comment",
        {
          instagramAccountId: event.instagramAccountId,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          source: "WEBHOOK",
        },
        {
          jobId: `comment_${event.instagramAccountId}_${event.commentId}`,
        }
      );

      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // Comments on a Live broadcast. Same shape as a feed comment once parsed,
    // so they ride the same job and the same worker path.
    const liveCommentEvents = parseLiveCommentEvents(
      payload as Parameters<typeof parseLiveCommentEvents>[0]
    );

    for (const event of liveCommentEvents) {
      await queue.add(
        "process-comment",
        {
          instagramAccountId: event.instagramAccountId,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          source: "LIVE",
        },
        {
          jobId: `live_${event.instagramAccountId}_${event.commentId}`,
        }
      );
    }

    // Arrivals carrying a ref from a link, QR code or website button. The ref
    // names the campaign, so this needs no keyword match.
    const referralEvents = parseReferralEvents(
      payload as Parameters<typeof parseReferralEvents>[0]
    );

    for (const event of referralEvents) {
      const automation = await prisma.automation.findFirst({
        where: {
          referralRef: event.ref,
          isActive: true,
          instagramAccount: { instagramId: event.instagramAccountId },
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
          userId: event.userId,
          payload: `reveal:${automation.id}`,
        },
        {
          jobId: `referral_${event.instagramAccountId}_${event.userId}_${automation.id}`,
        }
      );
    }

    // Button taps from opening DMs → deliver the reveal message.
    const postbackEvents = parsePostbackEvents(
      payload as Parameters<typeof parsePostbackEvents>[0]
    );

    for (const event of postbackEvents) {
      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
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
    }

    // Inbound DMs → keyword-triggered autoreply.
    const messageEvents = parseMessageEvents(
      payload as Parameters<typeof parseMessageEvents>[0]
    );

    for (const event of messageEvents) {
      const account = await prisma.instagramAccount.findUnique({
        where: { instagramId: event.instagramAccountId },
        select: { workspaceId: true },
      });

      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
          kind: event.kind,
          quickReplyPayload: event.quickReplyPayload,
        },
        {
          // Message ids can contain characters BullMQ rejects in a job id (":"
          // in particular). base64url encodes into exactly the allowed alphabet
          // and stays injective — substituting invalid characters would let two
          // distinct mids collapse onto one job id, silently dropping a reply.
          jobId: `message_${event.instagramAccountId}_${Buffer.from(
            event.messageId
          ).toString("base64url")}`,
        }
      );

      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    const readEvents = parseReadEvents(
      payload as Parameters<typeof parseReadEvents>[0]
    );

    for (const event of readEvents) {
      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          automation: {
            isActive: true,
            openingDmEnabled: true,
            instagramAccount: {
              instagramId: event.instagramAccountId,
            },
          },
        },
        select: {
          automation: {
            select: {
              id: true,
            },
          },
        },
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
    const messageEditEvents = parseMessageEditEvents(
      payload as Parameters<typeof parseMessageEditEvents>[0]
    );

    for (const event of messageEditEvents) {
      const account = await resolveAccount(event.instagramAccountId);
      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }

      // Editing a message must never earn a second DM. The worker's own
      // per-campaign guard stops the campaign that already replied, but it
      // would not stop a DIFFERENT campaign that the corrected text now
      // matches, so the question is asked once here for the whole message: has
      // anything already answered this mid? The key is the worker's
      // `dm:<messageId>` DmLog key.
      const alreadyAnswered = account
        ? await prisma.dmLog.findFirst({
            where: {
              instagramAccountId: account.id,
              commentId: `dm:${event.messageId}`,
              status: "SENT",
            },
            select: { id: true },
          })
        : null;
      if (alreadyAnswered) continue;

      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
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
    const echoEvents = parseMessageEchoEvents(
      payload as Parameters<typeof parseMessageEchoEvents>[0]
    );

    for (const event of echoEvents) {
      const workspaceId = await recordOutboundEcho(event);
      if (workspaceId) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId },
        });
      }
    }

    // Reactions on messages we delivered. A positive engagement signal worth
    // keeping for segmentation; an unreact is its withdrawal, so it is dropped
    // rather than recorded as engagement.
    const reactionEvents = parseReactionEvents(
      payload as Parameters<typeof parseReactionEvents>[0]
    );

    for (const event of reactionEvents) {
      if (event.action !== "react") continue;

      const workspaceId = await recordReaction(event);
      if (workspaceId) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId },
        });
      }
    }

    // Mentions of the account, in someone's caption or in a comment elsewhere.
    // Recorded and surfaced only. Wiring this to an automatic DM is a product
    // decision that has not been made.
    const mentionEvents = parseMentionEvents(
      payload as Parameters<typeof parseMentionEvents>[0]
    );

    for (const event of mentionEvents) {
      const workspaceId = await recordMention(event);
      if (workspaceId) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId },
        });
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
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

    return NextResponse.json(
      { success: false, error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
