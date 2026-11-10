import { classifySendError, isDeliveryUnconfirmed } from "@/lib/channels/errors";
import { claimCommentDelivery, MAX_COMMENT_SEND_ATTEMPTS } from "./comment-delivery";
import { createHash } from "node:crypto";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import {
  getDMQueue,
  getRedisConnection,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
  FOLLOWUP_JOB_NAME,
  type DmQueueJob,
  type ProcessCommentJob,
  type ProcessMessageJob,
  type ProcessPostbackJob,
  type ProcessFollowUpJob,
} from "./client";
import { prisma } from "@/lib/db/client";
import { canMessageContact } from "@/lib/messaging/opt-out";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import type { ChannelErrorRules } from "@/lib/channels/adapter";
import { inferAttachmentKind, type ButtonSpec } from "@/lib/channels/content";
import { resolveRecipientName } from "@/lib/channels/recipient-name";
import {
  getChannelAdapter,
  openChannel,
  type OpenChannel,
} from "@/lib/channels/registry";
import {
  isRoutablePostbackPayload,
  parseQuickReplies,
} from "@/lib/meta/quick-replies";
import { recordContactDm, upsertContact } from "@/lib/contacts";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { reserveDMSlot, releaseDMSlot } from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { recordWorkerAlert } from "@/lib/ops/worker-health";
import { answerInboundMessage } from "@/lib/ai/answering";
import { getAnsweringSettings } from "@/lib/ai/answering-settings";
import {
  buildTrackedUrl,
  renderMessageWithTracking,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { hashRecipientId } from "@/lib/tracking/server";

import { DEFAULT_FOLLOW_PROMPT } from "@/lib/campaigns/follow-prompt";

const BACKOFF_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];

// How long to wait before re-checking a follow that came back false: one
// delay per re-check, each counted from the previous check.
//
// `is_user_follow_business` does not reflect a brand-new follow right away, and
// the follow gate asks people to follow and tap a button that is sitting in
// front of them, so tapping seconds after following is the normal case, not
// the exception. Rejecting on the first `false` therefore turns away the exact
// people who did what was asked, and they get told to follow an account they
// already follow.
//
// Two checks rather than one long wait: measured, a follow still read `false`
// 17 s after it happened and `true` by ~68 s. An early check catches the fast
// ones sooner; the last still covers the slow ones.
const FOLLOW_RECHECK_DELAYS_MS = (
  process.env.FOLLOW_RECHECK_DELAYS_MS ?? "20000,40000"
)
  .split(",")
  .map(Number)
  .filter((ms) => ms > 0);
const FOLLOW_RECHECK_TOTAL_MS = FOLLOW_RECHECK_DELAYS_MS.reduce(
  (total, ms) => total + ms,
  0
);

/**
 * Sends Meta answered with an error but may well have delivered anyway.
 *
 * Meta returns the generic code 1 OAuthException on /messages *after* the DM
 * has reached the recipient, observed in production: a user tapped the reply's
 * button 30 seconds after a send this worker had already marked FAILED. Logging
 * that as a plain failure is harmful twice over: the job is retried (up to
 * BACKOFF_DELAYS.length times, each retry another copy in the same inbox), and
 * the comment never satisfies the reconciler's "handled" test, so every sweep
 * re-enqueues it for the whole lookback window. Together that sent one person
 * dozens of identical DMs.
 *
 * Flagging it as unconfirmed instead is exactly what dmDeliveryUnconfirmed is
 * for: the sweep's dedup already treats that as handled, and processComment
 * skips a DM whose delivery is unconfirmed. The trade-off is deliberate, a
 * code 1 that really did fail means that person gets no DM and can comment
 * again, which is far better than spamming someone who already received it.
 */

/**
 * The text stored on a log row. A platform error that carries a numeric code
 * is written as "<Name> <code>: <message>", the shape the legacy-unconfirmed
 * check reads back, so older rows and newer ones are judged the same way.
 */
function formatError(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  ) {
    return `${error.name} ${(error as { code: number }).code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

type WorkerTrackedLink = {
  slug: string;
  label: string | null;
  destinationUrl: string;
};

/**
 * Build the tappable link buttons for a DM. The first link uses the campaign's
 * `linkButtonLabel`; each additional link uses its own stored `label`. Capped at
 * Meta's 3-button limit for a button template.
 */
function buildLinkButtons(
  trackedLinks: WorkerTrackedLink[],
  primaryLabel: string | null,
  recipientToken: string
): { title: string; url: string }[] {
  return trackedLinks.slice(0, 3).map((link, index) => ({
    url: buildTrackedUrl(link.slug, undefined, recipientToken),
    title:
      (index === 0 ? primaryLabel : link.label) || link.label || "Open link",
  }));
}

/** Link buttons in the adapter's neutral shape. */
function linkButtonSpecs(buttons: { title: string; url: string }[]): ButtonSpec[] {
  return buttons.map((button) => ({ type: "url", title: button.title, url: button.url }));
}

/**
 * Fallback text when Meta rejects the button template: render the primary link
 * inline, then append any extra tracked URLs on their own lines so no link is
 * lost.
 */
function buildInlineLinkFallback(
  message: string,
  commenterName: string | null | undefined,
  trackedLinks: WorkerTrackedLink[],
  bodyText: string,
  recipientToken: string
): string {
  const base =
    renderMessageWithTracking({
      message,
      commenterName,
      trackedLinks,
      recipientToken,
    }) || bodyText;
  const extraUrls = trackedLinks
    .slice(1)
    .map((link) => buildTrackedUrl(link.slug, undefined, recipientToken));
  return extraUrls.length > 0 ? `${base}\n${extraUrls.join("\n")}` : base;
}

type RevealAutomation = {
  dmMessage: string;
  linkButtonLabel: string | null;
  attachmentUrl?: string | null;
  trackedLinks: WorkerTrackedLink[];
  instagramAccount: { instagramId: string };
  // Quick replies come off a JSON column, so what is stored is genuinely
  // unknown until parseQuickReplies has validated it. Optional because
  // campaigns written before the field existed carry neither.
  quickRepliesEnabled?: boolean;
  quickReplies?: unknown;
};

/**
 * Send a campaign's attachment, if it has one, after the message itself.
 *
 * Instagram carries either text or a file in one send, never both, so this is
 * always a second call and always lands under the message. Failures are
 * swallowed: the DM the recipient asked for has already gone out, and losing
 * the file is not a reason to fail the job and retry the whole sequence, which
 * would send the message twice.
 */
async function sendAttachmentIfAny(
  channel: OpenChannel,
  automation: { attachmentUrl?: string | null; instagramAccount: { instagramId: string } },
  userId: string,
  context: string
): Promise<void> {
  const url = automation.attachmentUrl?.trim();
  if (!url) return;

  try {
    await channel.adapter.messaging.send(channel.context, {
      to: { kind: "user", userId },
      content: {
        kind: "attachment",
        url,
        mediaType: inferAttachmentKind(url),
      },
    });
  } catch (error) {
    console.warn(
      `[DM Worker] Attachment failed in ${context}, message already delivered:`,
      formatError(error)
    );
  }
}

/**
 * Deliver a campaign's reveal message as a direct message. Shared by the
 * button-tap (postback) path and the DM keyword-trigger path, both already
 * have an open conversation with the user, so neither uses a private reply.
 */
async function sendRevealDirectMessage({
  channel,
  automation,
  userId,
  commenterName,
  context,
}: {
  channel: OpenChannel;
  automation: RevealAutomation;
  userId: string;
  commenterName: string | null;
  context: string;
}): Promise<void> {
  // Quick replies ride on a plain text message. A campaign that also has
  // tracked links sends a button template instead, and Instagram carries one or
  // the other on a message, not both, so the links win: they are the thing the
  // recipient asked for.
  const quickReplies = automation.quickRepliesEnabled
    ? parseQuickReplies(automation.quickReplies)
    : [];

  if (automation.trackedLinks.length === 0) {
    const text = renderMessageWithTracking({
      message: automation.dmMessage,
      commenterName,
      trackedLinks: automation.trackedLinks,
    });

    if (quickReplies.length > 0) {
      await channel.adapter.messaging.send(channel.context, {
        to: { kind: "user", userId },
        content: {
          kind: "text",
          text,
          quickReplies,
        },
      });
    } else {
      await channel.adapter.messaging.send(channel.context, {
        to: { kind: "user", userId },
        content: {
          kind: "text",
          text,
        },
      });
    }
    await sendAttachmentIfAny(channel, automation, userId, context);
    return;
  }

  // Try button template first; if Meta rejects it, fall back to inline links.
  const bodyText =
    renderMessageWithoutLink({
      message: automation.dmMessage,
      commenterName,
    }) || "Here's your link:";
  const recipientToken = hashRecipientId(userId);
  const buttons = buildLinkButtons(
    automation.trackedLinks,
    automation.linkButtonLabel,
    recipientToken
  );

  try {
    await channel.adapter.messaging.send(channel.context, {
      to: { kind: "user", userId },
      content: {
        kind: "buttons",
        text: bodyText,
        buttons: linkButtonSpecs(buttons),
      },
    });
  } catch (buttonError) {
    // A closed messaging window rejects the text retry too, so don't let it
    // overwrite the original error with a misleading one.
    if (!channel.adapter.errors.isRichContentRejection(buttonError)) throw buttonError;

    console.log(
      `[DM Worker] Button template rejected in ${context}, falling back to inline link:`,
      formatError(buttonError)
    );
    try {
      await channel.adapter.messaging.send(channel.context, {
        to: { kind: "user", userId },
        content: {
          kind: "text",
          text: buildInlineLinkFallback(
            automation.dmMessage,
            commenterName,
            automation.trackedLinks,
            bodyText,
            recipientToken
          ),
        },
      });
    } catch (fallbackError) {
      throw classifySendError(channel.adapter.errors, fallbackError);
    }
  }

  // Reached whether the button template worked or the inline fallback did, so
  // the file follows the message either way.
  await sendAttachmentIfAny(channel, automation, userId, context);
}


function connectionScope(data: DmQueueJob) {
  return data.accountConnectionId ? { instagramAccountId: data.accountConnectionId } : {};
}

async function processComment(job: Job<ProcessCommentJob>): Promise<void> {
  const {
    instagramAccountId,
    commentId,
    commentText,
    commenterId,
    commenterName,
    mediaId,
    originalMediaId,
  } = job.data;
  const requeueAttempt = job.data.requeueAttempt ?? 0;

  // A Live broadcast's media id matches no campaign's postId, and a feed
  // campaign set to "any post" should not start answering a livestream. Live
  // comments therefore select on their own opt-in rather than on the post.
  //
  // Feed comments match campaigns bound to this specific post, plus any-post
  // campaigns. A comment left on an ad carries the ad's own media id, while the
  // campaign is bound to the post the ad was created from, so both ids have to
  // be considered or the comment is dropped without a trace.
  const postFilter =
    job.data.source === "LIVE"
      ? { liveCommentEnabled: true }
      : {
          OR: [
            { postId: mediaId },
            ...(originalMediaId ? [{ postId: originalMediaId }] : []),
            { matchAnyPost: true },
          ],
        };

  const automations = await prisma.automation.findMany({
    where: {
      ...connectionScope(job.data),
      ...postFilter,
      isActive: true,
      instagramAccount: {
        instagramId: instagramAccountId,
      },
    },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: {
          slug: true,
          label: true,
          destinationUrl: true,
        },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const automation of automations) {
    // "Any word" campaigns fire on every comment; otherwise require a keyword hit.
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          commentText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) {
      continue;
    }

    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId,
        },
      },
    });

    if (existingLog?.status === "FAILED" && getChannelAdapter(automation.instagramAccount.platform).errors.isLegacyUnconfirmed(existingLog.errorMessage)) {
      await prisma.dmLog.update({
        where: { automationId_commentId: { automationId: automation.id, commentId } },
        data: { dmDeliveryUnconfirmed: true },
      });
      existingLog.dmDeliveryUnconfirmed = true;
    }

    const alreadyDmd = existingLog?.status === "SENT";
    const alreadyPublicReplied = Boolean(existingLog?.publicReplySentAt);
    const needsDm = !alreadyDmd && !existingLog?.dmDeliveryUnconfirmed &&
      (existingLog?.attempts ?? 0) < MAX_COMMENT_SEND_ATTEMPTS;

    // Skip only when there is genuinely nothing left to do. A comment whose DM
    // already sent but whose public reply never posted (e.g. it hit a rate
    // limit) must still come back so the public reply can be retried.
    if (existingLog?.status === "SKIPPED_PLAN_LIMIT") continue;
    if (
      !needsDm &&
      (alreadyPublicReplied || existingLog?.publicReplyDeliveryUnconfirmed || !automation.publicReplyEnabled)
    ) {
      continue;
    }

    if (!getChannelAdapter(automation.instagramAccount.platform).hasCredentials(
      automation.instagramAccount
    )) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
      });
      continue;
    }

    let channel: OpenChannel;
    try {
      channel = await openChannel(automation.instagramAccount);
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
      });
      continue;
    }

    await prisma.dmLog.upsert({
      where: { automationId_commentId: { automationId: automation.id, commentId } },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId, commenterName, commentText, commentId,
        matchedKeyword: matchResult.matchedKeyword,
        status: "PENDING",
      },
      update: {},
    });

    // Public reply leg, decoupled from the DM and posted first so a DM failure
    // (e.g. a non-follower whose messaging is restricted) never suppresses it.
    // Idempotent across retries via publicReplySentAt.
    const replyPool =
      automation.publicReplyMessages.length > 0
        ? automation.publicReplyMessages
        : automation.publicReplyMessage
          ? [automation.publicReplyMessage]
          : [];
    if (
      automation.publicReplyEnabled &&
      replyPool.length > 0 &&
      !existingLog?.publicReplySentAt &&
      !existingLog?.publicReplyDeliveryUnconfirmed &&
      await claimCommentDelivery(automation.id, commentId, "public")
    ) {
      try {
        const chosen = replyPool[Math.floor(Math.random() * replyPool.length)];
        const publicReply = renderMessageWithTracking({
          message: chosen,
          commenterName,
          trackedLinks: automation.trackedLinks,
        });
        await channel.adapter.messaging.publicReply(channel.context, {
          commentId,
          text: publicReply,
          postId: mediaId,
        });
        await prisma.dmLog.update({
          where: {
            automationId_commentId: { automationId: automation.id, commentId },
          },
          data: { publicReplySentAt: new Date(), publicReplyError: null, publicReplyDeliveryUnconfirmed: false },
        });
      } catch (error) {
        console.error(
          "[DM Worker] Public comment reply failed:",
          formatError(error)
        );
        await prisma.dmLog
          .update({
            where: {
              automationId_commentId: {
                automationId: automation.id,
                commentId,
              },
            },
            data: {
              publicReplyError: formatError(
                classifySendError(channel.adapter.errors, error)
              ),
              publicReplyDeliveryUnconfirmed:
                !channel.adapter.errors.isConfirmedRejection(error),
            },
          })
          .catch(() => {});
      }
    }

    // DM already sent on an earlier pass; the public reply retry above was all
    // this run needed. Don't re-send the DM.
    if (!needsDm) continue;

    // Meta allows exactly ONE private reply per comment, ever, across every
    // campaign. When several campaigns match the same comment (duplicated
    // campaigns, or an any-post campaign overlapping a post-specific one), only
    // the first can deliver; the rest would fail with "The comment is invalid
    // for a private reply". Skip them explicitly instead of burning an API call
    // and logging a failure the user can do nothing about. The public reply
    // above still goes out per campaign, only the DM leg is deduped.
    const privateReplyUsedBy = await prisma.dmLog.findFirst({
      where: {
        commentId,
        status: "SENT",
        automationId: { not: automation.id },
      },
      select: { automation: { select: { name: true } } },
    });
    if (privateReplyUsedBy) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: { automationId: automation.id, commentId },
        },
        data: {
          status: "SKIPPED_DEDUP",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Another campaign (${privateReplyUsedBy.automation?.name ?? "unknown"}) already sent the one private reply Instagram allows for this comment`,
        },
      });
      continue;
    }

    // Did this person already tell us to stop?
    //
    // Checked before any budget or rate-limit slot is reserved, so someone who
    // opted out never consumes either. An opt-out outranks a keyword match:
    // commenting again is not consent to be messaged again, and answering
    // anyway is the thing they explicitly asked us not to do.
    const optedOutContact = await prisma.contact.findUnique({
      where: {
        instagramAccountId_externalId: {
          instagramAccountId: automation.instagramAccount.id,
          externalId: commenterId,
        },
      },
      select: { optedOutAt: true },
    });

    if (!canMessageContact(optedOutContact?.optedOutAt)) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: { automationId: automation.id, commentId },
        },
        data: {
          status: "SKIPPED_OPTED_OUT",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: "This person replied STOP, so no DM was sent",
        },
      });
      continue;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SKIPPED_PLAN_LIMIT",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    let rateLimit;
    try {
      rateLimit = await reserveDMSlot(instagramAccountId, requeueAttempt);
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "FAILED",
          errorMessage: formatError(error),
        },
      });
      throw error;
    }

    if (!rateLimit.allowed) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );

      if (rateLimit.shouldSkip) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "SKIPPED_RATE_LIMIT",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly Instagram DM rate limit reached",
          },
        });
        continue;
      }

      // A Live comment cannot be retried. Instagram only accepts a private
      // reply to a Live comment while the broadcast is running, and the requeue
      // delay is half an hour, so a retry lands after the stream has ended and
      // fails. Worse, it would burn three attempts producing failures that look
      // transient. Record it as skipped with a reason the operator can act on,
      // which is to raise the cap or send fewer during a stream.
      if (rateLimit.shouldRequeue && job.data.source === "LIVE") {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "SKIPPED_RATE_LIMIT",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage:
              "Rate limit hit during a Live broadcast. Instagram only accepts a private reply while the stream is running, so this cannot be retried.",
          },
        });
        continue;
      }

      if (rateLimit.shouldRequeue) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "PENDING",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly rate limit hit; retry scheduled",
          },
        });

        await getDMQueue().add(
          "process-comment",
          {
            ...job.data,
            requeueAttempt: requeueAttempt + 1,
          },
          {
            delay: rateLimit.requeueDelayMs,
            jobId: `comment_${instagramAccountId}_${commentId}_retry_${requeueAttempt + 1}`,
          }
        );
        continue;
      }
    }

    // With an opening DM, the private reply is a button message; tapping it
    // fires a postback that delivers the reveal (see processPostback). Without
    // one, we send the reveal text directly as today.
    const useOpeningDm =
      automation.openingDmEnabled &&
      Boolean(automation.openingDmMessage) &&
      Boolean(automation.openingDmButtonLabel);

    // Follow-gating: the link is revealed only after a follow. When an opening
    // DM is enabled it comes FIRST, and its button routes into the follow check
    // (opening DM → follow gate → link). Without an opening DM, we check follow
    // status at comment time: confirmed followers get the link now, everyone
    // else gets the "follow me first" prompt (re-verified on tap).
    let sendFollowPrompt = false;
    if (automation.requireFollow && !useOpeningDm) {
      const alreadyFollows = await channel.adapter.messaging.followStatus(
        channel.context,
        commenterId
      );
      sendFollowPrompt = alreadyFollows !== true;
    }

    let claimed;
    try {
      claimed = await claimCommentDelivery(automation.id, commentId, "dm");
    } catch (error) {
      if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
      await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
      throw error;
    }
    if (!claimed) {
      if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
      await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
      continue;
    }
    let delivered = false;
    try {
      if (useOpeningDm) {
        const openingText = renderMessageWithTracking({
          message: automation.openingDmMessage as string,
          commenterName,
          trackedLinks: [],
        });
        await channel.adapter.messaging.send(channel.context, {
          to: { kind: "comment", commentId, postId: mediaId },
          content: {
            kind: "buttons",
            text: openingText,
            buttons: [
              {
                type: "postback",
                title: automation.openingDmButtonLabel as string,
                // The ":open" marker tells a tap here apart from the follow
                // prompt's own "I'm following" button, which sends the same
                // prefix.
                payload: `${automation.requireFollow ? "followcheck" : "reveal"}:${automation.id}:open`,
              },
            ],
          },
        });
      } else if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            DEFAULT_FOLLOW_PROMPT,
          commenterName,
        });
        await channel.adapter.messaging.send(channel.context, {
          to: { kind: "comment", commentId, postId: mediaId },
          content: {
            kind: "buttons",
            text: promptText,
            buttons: [
              {
                type: "postback",
                title: automation.followPromptButtonLabel || "i'm following",
                payload: `followcheck:${automation.id}`,
              },
            ],
          },
        });
      } else if (automation.trackedLinks.length > 0) {
        // Try button template first; if Meta rejects it, fall back to inline links.
        const bodyText =
          renderMessageWithoutLink({
            message: automation.dmMessage,
            commenterName,
          }) || "Here's your link:";
        const buttons = buildLinkButtons(
          automation.trackedLinks,
          automation.linkButtonLabel,
          hashRecipientId(commenterId)
        );

        try {
          await channel.adapter.messaging.send(channel.context, {
            to: { kind: "comment", commentId, postId: mediaId },
            content: {
              kind: "buttons",
              text: bodyText,
              buttons: linkButtonSpecs(buttons),
            },
          });
        } catch (buttonError) {
          // Only a template rejection is worth retrying as text. Anything else
          // (closed window, comment already replied to) fails the same way and
          // would replace the real error with a misleading one.
          if (!channel.adapter.errors.isRichContentRejection(buttonError)) throw buttonError;

          console.log(
            "[DM Worker] Button template rejected, falling back to inline link:",
            formatError(buttonError)
          );
          const fallbackMessage = buildInlineLinkFallback(
            automation.dmMessage,
            commenterName,
            automation.trackedLinks,
            bodyText,
            hashRecipientId(commenterId)
          );
          try {
            await channel.adapter.messaging.send(channel.context, {
              to: { kind: "comment", commentId, postId: mediaId },
              content: {
                kind: "text",
                text: fallbackMessage,
              },
            });
          } catch (fallbackError) {
            throw classifySendError(channel.adapter.errors, fallbackError);
          }
        }
      } else {
        const dmMessage = renderMessageWithTracking({
          message: automation.dmMessage,
          commenterName,
          trackedLinks: automation.trackedLinks,
          recipientToken: hashRecipientId(commenterId),
        });
        await channel.adapter.messaging.send(channel.context, {
          to: { kind: "comment", commentId, postId: mediaId },
          content: {
            kind: "text",
            text: dmMessage,
          },
        });
      }

      delivered = true;
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SENT",
          dmSentAt: new Date(),
          dmDeliveryUnconfirmed: false,
          errorMessage: null,
        },
      });
    } catch (error) {
      const sendError = classifySendError(channel.adapter.errors, error);
      // Retain reservations if the provider may have delivered the message.
      if (channel.adapter.errors.isConfirmedRejection(sendError)) {
        if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
        await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
      }
      await prisma.dmLog.update({
        where: { automationId_commentId: { automationId: automation.id, commentId } },
        data: {
          status: delivered ? "SENT" : "FAILED",
          ...(delivered ? { dmSentAt: new Date() } : {}),
          errorMessage: formatError(sendError),
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(sendError),
        },
      });
      throw sendError;
    }
  }
}

async function sendPostbackOnce({
  operationId,
  errors,
  send,
}: {
  operationId: string;
  /** The platform's rules for whether a failed send is a confirmed refusal. */
  errors: ChannelErrorRules;
  send: () => Promise<unknown>;
}): Promise<boolean> {
  try {
    await prisma.postbackDelivery.create({ data: { id: operationId } });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    )
      return false;
    throw error;
  }
  try {
    await send();
    return true;
  } catch (error) {
    // A durable claim survives queue eviction, concurrent redelivery, and a
    // process crash during delivery. Only confirmed rejections permit retry.
    if (errors.isConfirmedRejection(error)) {
      await prisma.postbackDelivery.delete({ where: { id: operationId } });
      throw error;
    }
    throw classifySendError(errors, error);
  }
}

// Tells someone whose "I'm following" tap is being re-checked that it is being
// looked at, so the chat does not sit silent while Instagram catches up with
// the follow. Opt-in through FOLLOW_RECHECK_ACK_MESSAGE, and best-effort: it
// never holds up the re-check, which is already queued when this runs.
async function sendFollowRecheckAck({
  channel,
  automationId,
  userId,
  operationId,
}: {
  channel: OpenChannel;
  automationId: string;
  userId: string;
  operationId: string | null;
}): Promise<void> {
  const message = process.env.FOLLOW_RECHECK_ACK_MESSAGE?.trim();
  if (!message) return;
  try {
    // One acknowledgement per re-check cycle: a burst of taps collapses into a
    // single re-check (bucketed job id) and should get a single reply too.
    const first = await getRedisConnection().set(
      `follow_recheck_ack:${automationId}:${userId}`,
      "1",
      "PX",
      FOLLOW_RECHECK_TOTAL_MS,
      "NX"
    );
    if (first !== "OK") return;
    const send = () =>
      channel.adapter.messaging.send(channel.context, {
        to: { kind: "user", userId },
        content: { kind: "text", text: message },
      });
    // Its own id: the tap's id is claimed later by the link or prompt that
    // the re-check sends, and claiming it here would suppress that message.
    // Without an id the Redis NX above is the only dedupe.
    if (operationId) {
      await sendPostbackOnce({
        operationId: `${operationId}:ack`,
        errors: channel.adapter.errors,
        send,
      });
    } else {
      await send();
    }
  } catch (error) {
    console.log(
      "[DM Worker] Failed to send follow re-check acknowledgement:",
      formatError(error),
    );
  }
}

/**
 * Deliver the reveal message after a user taps an opening DM's button.
 * The postback payload is `reveal:<automationId>`; the sender is the user's
 * IGSID (same id as their comment author id), which we DM directly.
 */
/**
 * A token that will not decrypt is a silent, total outage: every send using it
 * fails identically and nothing retries. It has to leave a trace the operator
 * can actually see, which means the workspace's own OperationalEvent feed,
 * because that is what the diagnostics page reads.
 */
async function recordDecryptFailure(
  workspaceId: string,
  automationId: string,
  instagramAccountId: string
): Promise<void> {
  try {
    await prisma.operationalEvent.create({
      data: {
        workspaceId,
        source: "WORKER",
        level: "ERROR",
        message: "Failed to decrypt Instagram access token",
        payload: { automationId, instagramAccountId },
      },
    });
  } catch (error) {
    // Recording the failure must never become a second failure.
    console.error(
      "[DM Worker] Failed to record decrypt failure:",
      formatError(error)
    );
  }
}

async function processPostback(job: Job<ProcessPostbackJob>): Promise<void> {
  const { instagramAccountId, userId, payload, fallback } = job.data;

  const isFollowCheck = payload.startsWith("followcheck:");
  if (!isFollowCheck && !payload.startsWith("reveal:")) return;
  // The opening DM's button appends ":open" to the payload; the follow
  // prompt's button does not. Automation ids are cuids and contain no colon.
  const [automationId, marker] = payload
    .slice(isFollowCheck ? "followcheck:".length : "reveal:".length)
    .split(":");
  const fromOpeningDm = marker === "open";

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true, ...connectionScope(job.data) },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
  });

  if (
    !automation ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !getChannelAdapter(automation.instagramAccount.platform).hasCredentials(
      automation.instagramAccount
    )
  ) {
    return;
  }

  // Duplicate sends are enabled: every button tap re-sends the reveal
  // instead of only firing once per person.
  const dedupeId = `reveal:${userId}`;

  if (fallback) {
    const existingReveal = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
    });
    if (
      existingReveal?.status === "SENT" ||
      existingReveal?.dmDeliveryUnconfirmed
    )
      return;
  }

  let channel: OpenChannel;
  try {
    channel = await openChannel(automation.instagramAccount);
  } catch {
    // Returning silently here marked the job completed, so BullMQ never
    // retried and nothing was written anywhere: no DmLog, no OperationalEvent,
    // no console line. Rotate ENCRYPTION_KEY and every reveal DM and follow-up
    // stops delivering while the dashboard shows zero failures, the worker
    // heartbeat stays green and the campaigns look healthy. The equivalent
    // path at the comment handler already records this properly.
    await recordDecryptFailure(
      automation.workspaceId,
      automation.id,
      automation.instagramAccount.id
    );
    return;
  }

  // Personalize {username}. The postback carries only the tapper's IGSID.
  const commenterName = await resolveRecipientName({
    channel,
    workspaceId: automation.workspaceId,
    recipientId: userId,
  });

  const operationId = createHash("sha256")
    .update(JSON.stringify([
      automation.instagramAccountId,
      automation.id,
      userId,
      job.data.mid ?? job.id ?? payload,
    ]))
    .digest("hex");

  // Follow-gate: before revealing the link, verify the user follows. On a
  // `followcheck:` tap a non-follower gets the prompt again (no quota spent);
  // on a read fallback a non-follower is silently skipped, the gate must not
  // be bypassable by just reading the DM and waiting. On a tap, following or
  // unverifiable (null) falls through and delivers the link, fail-open so a
  // real follower is never trapped.
  if ((isFollowCheck || fallback) && automation.requireFollow) {
    const follows = await channel.adapter.messaging.followStatus(
      channel.context,
      userId
    );
    // A read fallback needs a confirmed follow. Instagram only reports follow
    // status once the person has tapped a button (before that it answers
    // "User consent is required", i.e. null), so failing open here handed the
    // link to anyone who read the opening DM and waited, follower or not.
    if (fallback && follows !== true) return;
    if (follows === false) {
      if (fallback) return;

      // A tap on an opening-DM button is not a claim to follow, most people
      // who tap it simply don't follow yet, so they get the follow prompt
      // right away. Only the prompt's own button earns the delayed re-check;
      // holding an opening tap for it left people staring at a silent chat.
      if (!fromOpeningDm) {
        // A `false` on a button tap: give the follow time to register and look
        // again, rather than rejecting someone who just followed.
        //
        // The job id is bucketed by the recheck window, not fixed per user.
        // BullMQ keeps completed jobs (removeOnComplete: count 1000) and silently
        // drops an add whose id is still retained, so a fixed id let a person be
        // re-checked once and then never again, their next false tap did
        // nothing at all, no link and no prompt. Bucketing still collapses a burst
        // of taps into a single re-check, which is what the fixed id was for.
        //
        // Jobs queued before re-checks were counted carry only `followRecheck`,
        // which meant one re-check done.
        const rechecksDone =
          job.data.followRecheckAttempt ?? (job.data.followRecheck ? 1 : 0);
        if (rechecksDone < FOLLOW_RECHECK_DELAYS_MS.length) {
          const delay = FOLLOW_RECHECK_DELAYS_MS[rechecksDone];
          const window = Math.floor(Date.now() / delay);
          await getDMQueue().add(
            POSTBACK_JOB_NAME,
            {
              ...job.data,
              followRecheck: true,
              followRecheckAttempt: rechecksDone + 1,
            },
            {
              delay,
              jobId: `postback_recheck_${automation.id}_${userId}_${rechecksDone + 1}_${window}`,
            }
          );
          if (rechecksDone === 0) {
            await sendFollowRecheckAck({
              channel,
              automationId: automation.id,
              userId,
              operationId,
            });
          }
          return;
        }

        // Last `false`: they are genuinely not following. Record it, this
        // branch used to return without writing anything at all, so a gate that
        // turned people away left no trace and its rejection rate could not be
        // measured, only guessed at from complaints.
        await prisma.operationalEvent
          .create({
            data: {
              workspaceId: automation.workspaceId,
              source: "WORKER",
              level: "INFO",
              message: "Follow gate rejected a button tap",
              payload: {
                automationId: automation.id,
                automationName: automation.name,
                userId,
                commenterName,
              },
            },
          })
          .catch(() => {});
      }

      const promptText = renderMessageWithoutLink({
        message:
          automation.followPromptMessage ||
          DEFAULT_FOLLOW_PROMPT,
        commenterName,
      });
      try {
        await sendPostbackOnce({
          operationId,
          errors: channel.adapter.errors,
          send: () =>
            channel.adapter.messaging.send(channel.context, {
              to: { kind: "user", userId },
              content: {
                kind: "buttons",
                text: promptText,
                buttons: [
                  {
                    type: "postback",
                    title: automation.followPromptButtonLabel || "i'm following",
                    payload: `followcheck:${automation.id}`,
                  },
                ],
              },
            }),
        });
      } catch (error) {
        console.log(
          "[DM Worker] Failed to re-send follow prompt:",
          formatError(error),
        );
      }
      return;
    }
  }

  const usage = await reserveWorkspaceDMSend(automation.workspaceId);
  if (!usage.allowed) {
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "SKIPPED_PLAN_LIMIT",
        errorMessage: `Monthly DM limit reached (${usage.limit})`,
      },
      update: { status: "SKIPPED_PLAN_LIMIT" },
    });
    return;
  }

  try {
    const delivered = await sendPostbackOnce({
      operationId,
      errors: channel.adapter.errors,
      send: () =>
        sendRevealDirectMessage({
          channel: channel,
          automation: automation,
          userId: userId,
          commenterName: commenterName,
          context: "postback",
        }),
    });
    if (!delivered) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart,
      );
      return;
    }
    // Optional appreciation follow-up: once the link has been delivered, send a
    // short thank-you. It is scheduled as its own delayed job so it can go out
    // some minutes later (followUpDelayMinutes) rather than immediately. The
    // deterministic job id dedupes repeat button taps to one follow-up per user.
    if (automation.followUpEnabled && automation.followUpMessage?.trim()) {
      const delayMs =
        Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000;
      await getDMQueue().add(
        FOLLOWUP_JOB_NAME,
        {
          instagramAccountId: automation.instagramAccount.instagramId,
          accountConnectionId: automation.instagramAccountId,
          userId,
          automationId: automation.id,
          commenterName,
        },
        {
          delay: delayMs,
          jobId: `followup_${automation.id}_${userId}`,
        },
      );
    }
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "SENT",
        dmSentAt: new Date(),
      },
      update: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
    });
  } catch (originalError) {
    const error = classifySendError(channel.adapter.errors, originalError);
    if (channel.adapter.errors.isConfirmedRejection(error)) await releaseWorkspaceDMReservation(
      automation.workspaceId,
      usage.periodStart,
    );

    // The read fallback is speculative: it only runs when the user read the
    // opening DM and never tapped the button, which means they never messaged
    // us, which means the 24-hour window is closed and Meta rejects the send
    // ("outside of allowed window"). That is the expected outcome here, not a
    // failure the user can act on, so don't log it as FAILED and don't retry
    // it against a window that cannot reopen on its own. It still delivers in
    // the case that does work: the user replied by typing instead of tapping.
    if (fallback && !isDeliveryUnconfirmed(error)) {
      console.log(
        "[DM Worker] Read fallback not delivered (messaging window closed):",
        formatError(error),
      );
      return;
    }

    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "FAILED",
        errorMessage: formatError(error),
        dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
      },
      update: {
        status: "FAILED",
        errorMessage: formatError(error),
        dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
      },
    });
    throw error;
  }
}

/**
 * Send the scheduled appreciation follow-up. Runs after its delay elapses.
 * Best-effort: if the message can't be delivered (e.g. the 24-hour messaging
 * window closed because the delay was long), it is logged, not retried forever.
 */
async function processFollowUp(job: Job<ProcessFollowUpJob>): Promise<void> {
  const { instagramAccountId, userId, automationId, commenterName } = job.data;

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true, ...connectionScope(job.data) },
    include: { instagramAccount: true, workspace: true },
  });

  if (
    !automation ||
    !automation.followUpEnabled ||
    !automation.followUpMessage?.trim() ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !getChannelAdapter(automation.instagramAccount.platform).hasCredentials(
      automation.instagramAccount
    )
  ) {
    return;
  }

  // Did this person tell us to stop? A follow-up is the message they are most
  // likely to have been reacting to when they did.
  const contact = await prisma.contact.findUnique({
    where: {
      instagramAccountId_externalId: {
        instagramAccountId: automation.instagramAccount.id,
        externalId: userId,
      },
    },
    select: { optedOutAt: true },
  });

  if (!canMessageContact(contact?.optedOutAt)) {
    return;
  }

  // Quiet hours. Only the follow-up is held: the campaign's first reply went
  // out the moment they commented, which is the whole point of the product.
  // This is the one that would otherwise arrive at 3am unasked.
  //
  // Requeued rather than dropped, so it lands when the window opens instead of
  // never. The delay is computed against the workspace's own timezone.
  const quiet = checkQuietHours(automation.workspace, new Date());
  if (quiet.quiet) {
    await getDMQueue().add(FOLLOWUP_JOB_NAME, job.data, {
      delay: quiet.retryAfterMs,
    });
    console.log(
      `[DM Worker] Follow-up held for quiet hours (local ${quiet.localHour}:00 in ${automation.workspace.timezone}), retrying in ${Math.round(quiet.retryAfterMs / 60000)}m`
    );
    return;
  }

  let channel: OpenChannel;
  try {
    channel = await openChannel(automation.instagramAccount);
  } catch {
    // Returning silently here marked the job completed, so BullMQ never
    // retried and nothing was written anywhere: no DmLog, no OperationalEvent,
    // no console line. Rotate ENCRYPTION_KEY and every reveal DM and follow-up
    // stops delivering while the dashboard shows zero failures, the worker
    // heartbeat stays green and the campaigns look healthy. The equivalent
    // path at the comment handler already records this properly.
    await recordDecryptFailure(
      automation.workspaceId,
      automation.id,
      automation.instagramAccount.id
    );
    return;
  }

  try {
    await channel.adapter.messaging.send(channel.context, {
      to: { kind: "user", userId },
      content: {
        kind: "text",
        text: renderMessageWithoutLink({
          message: automation.followUpMessage,
          commenterName: commenterName ?? null,
        }),
      },
    });
  } catch (error) {
    console.log(
      "[DM Worker] Failed to send follow-up message:",
      formatError(error)
    );
  }
}

/**
 * The payload of a quick reply the user just tapped, when the message carries
 * one the postback handler can act on.
 *
 * Instagram delivers a quick reply tap as an ordinary message that also carries
 * our payload, so it arrives on the message job rather than the postback one.
 * The field is read off `unknown` on purpose: jobs enqueued before quick
 * replies existed do not carry it, and neither does the queue's job type.
 *
 * A payload we cannot route (a campaign author typed a keyword rather than a
 * campaign reference) returns null, and the tap falls through to the ordinary
 * keyword path, because Instagram posts the button's title to the conversation
 * as the user's own message.
 */
function readQuickReplyPayload(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const payload = (data as { quickReplyPayload?: unknown }).quickReplyPayload;
  if (typeof payload !== "string" || payload.length === 0) return null;
  return isRoutablePostbackPayload(payload) ? payload : null;
}

/**
 * Reply to an inbound DM whose text matches a campaign's keywords.
 *
 * The user has messaged us, so the conversation is already open: this path
 * skips the opening DM (which exists to work around private-reply limits from
 * comments) and delivers the reveal directly, honouring the follow gate.
 * Dedup is per inbound message id, so each message triggers at most one reply.
 */
async function processMessage(job: Job<ProcessMessageJob>): Promise<void> {
  const { instagramAccountId, messageId, messageText, senderId } = job.data;
  // Jobs enqueued before story triggers existed carry no kind.
  const kind = job.data.kind ?? "dm";

  // A quick reply tap already names the follow-up it wants, so it never goes
  // near the keyword matcher. Hand it to the postback handler, which is what
  // already resolves `reveal:` and `followcheck:` payloads, rather than
  // standing up a second delivery path that would have to repeat its follow
  // gate, usage reservation and logging.
  const quickReplyPayload = readQuickReplyPayload(job.data);
  if (quickReplyPayload) {
    return processPostback({
      ...job,
      data: {
        instagramAccountId,
        userId: senderId,
        payload: quickReplyPayload,
      },
    } as unknown as Job<ProcessPostbackJob>);
  }

  // Each inbound surface has its own opt-in, so enabling story replies does
  // not silently start answering every DM, and vice versa. "default" is not a
  // surface: it is the fallback pass, entered only after every keyword
  // campaign has declined an ordinary DM.
  const triggerFilter =
    kind === "story_reply"
      ? { storyReplyEnabled: true }
      : kind === "story_mention"
        ? { storyMentionEnabled: true }
        : kind === "default"
          ? { defaultReplyEnabled: true }
          : { dmTriggerEnabled: true };

  const automations = await prisma.automation.findMany({
    where: {
      ...connectionScope(job.data),
      ...triggerFilter,
      isActive: true,
      instagramAccount: { instagramId: instagramAccountId },
    },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const dedupeId = `dm:${messageId}`;
  let anyMatched = false;

  for (const automation of automations) {
    // A story mention carries no text, so there is nothing to match on: being
    // mentioned is itself the trigger. The default-reply pass has already
    // established that nothing matched, so it does not re-check either.
    const matchResult =
      kind === "story_mention" || kind === "default" || automation.matchAnyWord
        ? { matched: true, matchedKeyword: null }
        : matchKeywords(
            messageText,
            automation.keywords,
            automation.wholeWordMatch
          );

    if (!matchResult.matched) continue;
    anyMatched = true;

    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
    });

    // Already replied to this message (or deliberately skipped it), a retry
    // of the job must not send a second DM.
    if (
      existingLog?.status === "SENT" ||
      existingLog?.status === "SKIPPED_PLAN_LIMIT" ||
      existingLog?.dmDeliveryUnconfirmed
    ) {
      continue;
    }

    // Resolve the person behind this message before logging, so the row links
    // to a contact rather than repeating a bare platform id. Returns null on
    // failure and the send proceeds regardless: contact bookkeeping must never
    // cost a recipient the DM they asked for.
    const contact = await upsertContact({
      workspaceId: automation.workspaceId,
      instagramAccountId: automation.instagramAccountId,
      externalId: senderId,
    });

    const logBase = {
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      instagramAccountId: automation.instagramAccountId,
      commenterId: senderId,
      contactId: contact?.id ?? null,
      commentText: messageText,
      commentId: dedupeId,
      matchedKeyword: matchResult.matchedKeyword,
    };

    if (!getChannelAdapter(automation.instagramAccount.platform).hasCredentials(
      automation.instagramAccount
    )) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
      });
      continue;
    }

    let channel: OpenChannel;
    try {
      channel = await openChannel(automation.instagramAccount);
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
      });
      continue;
    }

    // Personalize {username}. The messages webhook carries only the sender's
    // IGSID, so the handle is recovered from an earlier send or read live.
    const commenterName = await resolveRecipientName({
      channel,
      workspaceId: automation.workspaceId,
      recipientId: senderId,
    });

    // Follow gate: anyone not confirmed as a follower gets the prompt instead of
    // the link, with the same `followcheck:` button that re-verifies on tap.
    // `null` (unverifiable) prompts too, this is first contact, exactly like a
    // comment, so it follows processComment's fail-closed rule rather than the
    // postback path's fail-open one. Fail-open is only safe after a tap, where
    // the user has already claimed to follow; here it would hand the link to
    // anyone whose status the API happens not to resolve.
    let sendFollowPrompt = false;
    if (automation.requireFollow) {
      const follows = await channel.adapter.messaging.followStatus(
        channel.context,
        senderId
      );
      sendFollowPrompt = follows !== true;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
        update: {
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    try {
      if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            "Almost there! Follow me and tap the button below to grab your link 💛",
          commenterName,
        });
        await channel.adapter.messaging.send(channel.context, {
          to: { kind: "user", userId: senderId },
          content: {
            kind: "buttons",
            text: promptText,
            buttons: [
              {
                type: "postback",
                title: automation.followPromptButtonLabel || "I'm following ✅",
                payload: `followcheck:${automation.id}`,
              },
            ],
          },
        });
      } else {
        await sendRevealDirectMessage({
          channel: channel,
          automation: automation,
          userId: senderId,
          commenterName: commenterName,
          context: "message trigger",
        });

        // The link has been delivered, so the appreciation follow-up applies
        // here exactly as it does after a button tap. Not scheduled behind the
        // follow prompt, no link went out yet in that branch.
        if (automation.followUpEnabled && automation.followUpMessage?.trim()) {
          await getDMQueue().add(
            FOLLOWUP_JOB_NAME,
            {
              instagramAccountId: automation.instagramAccount.instagramId,
              accountConnectionId: automation.instagramAccountId,
              userId: senderId,
              automationId: automation.id,
              commenterName,
            },
            {
              delay: Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000,
              jobId: `followup_${automation.id}_${senderId}`,
            }
          );
        }
      }

      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "SENT",
          dmSentAt: new Date(),
        },
        update: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
        },
      });

      // Counter moves only on an actual send, not on every event seen.
      if (contact) await recordContactDm(contact.id);
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
        },
        update: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
        },
      });
      throw error;
    }
  }

  // Nothing wanted this message. The assistant gets first refusal, then the
  // default-reply campaign. Only for ordinary DMs: an unanswered story mention
  // should stay silent rather than trigger a generic reply.
  if (!anyMatched && kind === "dm") {
    const answered = await tryAssistantAnswer(job);
    if (answered) return;
    await runDefaultReply(job);
  }
}

/**
 * Try to answer an unmatched DM from the workspace's knowledge base.
 *
 * Returns true only when a reply was actually delivered, which is the one case
 * where the default-reply campaign must not also fire: two messages for one
 * inbound DM is worse than the generic one on its own.
 *
 * Everything here is wrapped, on purpose. The assistant is the newest and
 * least proven thing in this pipeline and it sits directly in front of a
 * campaign's send. Any failure inside it, a provider outage, a missing key, a
 * bad row, a bug in retrieval, has to end as "false" so the default reply still
 * goes out, and the failure is logged rather than swallowed.
 *
 * All of the policy lives in lib/ai/answering. This function's whole job is to
 * find the account, resolve the contact and hand over a way to send.
 */
async function tryAssistantAnswer(job: Job<ProcessMessageJob>): Promise<boolean> {
  const { instagramAccountId, messageId, messageText, senderId } = job.data;

  try {
    const account = await prisma.instagramAccount.findFirst({
      where: {
        instagramId: instagramAccountId,
        // Bound to the connection the webhook resolved, like every other job.
        ...(job.data.accountConnectionId
          ? { id: job.data.accountConnectionId }
          : {}),
      },
      select: {
        id: true,
        instagramId: true,
        accessToken: true,
        workspaceId: true,
        platform: true,
        workspace: { select: { name: true } },
      },
    });
    if (!account || !getChannelAdapter(account.platform).hasCredentials(account)) {
      return false;
    }

    const settings = await getAnsweringSettings(account.workspaceId);
    if (!settings.enabled) return false;

    const channel = await openChannel(account);

    const contact = await upsertContact({
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      externalId: senderId,
    });

    // An assistant reply is a DM the workspace sent, so it is counted like one.
    const usage = await reserveWorkspaceDMSend(account.workspaceId);
    if (!usage.allowed) return false;

    let delivered = false;

    const outcome = await answerInboundMessage({
      workspaceId: account.workspaceId,
      workspaceName: account.workspace.name,
      instagramAccountId: account.id,
      contactId: contact?.id ?? null,
      recipientId: senderId,
      messageId,
      question: messageText,
      // BullMQ stamps the job when it is enqueued, which is when the webhook
      // arrived. That is the closest thing we have to when the customer hit
      // send, and it is what the 24 hour window has to be measured from: a job
      // that sat in a retry backoff overnight must not answer on a stale clock.
      customerMessageAt: new Date(job.timestamp ?? Date.now()),
      send: async (text: string): Promise<void> => {
        await channel.adapter.messaging.send(channel.context, {
          to: { kind: "user", userId: senderId },
          content: {
            kind: "text",
            text,
          },
        });
        delivered = true;
      },
    });

    if (!delivered) {
      await releaseWorkspaceDMReservation(account.workspaceId, usage.periodStart);
    } else if (contact) {
      await recordContactDm(contact.id);
    }

    return outcome.status === "sent";
  } catch (error) {
    console.error("[DM Worker] Assistant answer failed, falling through:", {
      messageId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

/**
 * Answer an inbound DM that matched no keyword campaign.
 *
 * Re-enters processMessage with kind "default" rather than duplicating the
 * send, rate-limit, usage and logging logic. That kind selects only campaigns
 * with defaultReplyEnabled and never falls back again, so the recursion is one
 * level deep by construction.
 */
async function runDefaultReply(job: Job<ProcessMessageJob>): Promise<void> {
  await processMessage({
    ...job,
    data: { ...job.data, kind: "default" },
  } as Job<ProcessMessageJob>);
}

async function dispatchJob(job: Job<DmQueueJob>): Promise<void> {
  if (job.name === POSTBACK_JOB_NAME) {
    return processPostback(job as Job<ProcessPostbackJob>);
  }
  if (job.name === FOLLOWUP_JOB_NAME) {
    return processFollowUp(job as Job<ProcessFollowUpJob>);
  }
  if (job.name === MESSAGE_JOB_NAME) {
    return processMessage(job as Job<ProcessMessageJob>);
  }
  return processComment(job as Job<ProcessCommentJob>);
}

async function processJob(job: Job<DmQueueJob>): Promise<void> {
  try {
    await dispatchJob(job);
  } catch (error) {
    // formatError() takes unknown; isDeliveryUnconfirmed() is a type guard on
    // Error subclasses, but keep using formatError() for a consistent message
    // format across every UnrecoverableError thrown from this worker.
    if (isDeliveryUnconfirmed(error))
      throw new UnrecoverableError(formatError(error));
    throw error;
  }
}

async function recordWorkerFailure(
  job: Job<DmQueueJob> | undefined,
  error: Error
) {
  try {
    const instagramAccountId = job?.data.instagramAccountId;
    const commentId =
      job && "commentId" in job.data ? job.data.commentId : null;
    const account = instagramAccountId
      ? await prisma.instagramAccount.findUnique({
          where: { instagramId: instagramAccountId },
          select: { workspaceId: true },
        })
      : null;

    await prisma.operationalEvent.create({
      data: {
        workspaceId: account?.workspaceId ?? null,
        source: "WORKER",
        level: "ERROR",
        message: `DM worker job ${job?.id ?? "unknown"} failed: ${error.message}`,
        payload: {
          jobId: job?.id ?? null,
          attemptsMade: job?.attemptsMade ?? null,
          instagramAccountId: instagramAccountId ?? null,
          commentId,
        },
      },
    });

    await recordWorkerAlert({
      level: "error",
      message: error.message,
      jobId: job?.id,
      instagramAccountId,
      commentId: commentId ?? undefined,
    });
  } catch (recordError) {
    console.error(
      "[DM Worker] Failed to record worker failure:",
      formatError(recordError)
    );
  }
}

export function createDMWorker(): Worker<DmQueueJob> {
  const worker = new Worker<DmQueueJob>("dm-processing", processJob, {
    connection: getRedisConnection(),
    concurrency: 5,
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        BACKOFF_DELAYS[Math.min(attemptsMade - 1, BACKOFF_DELAYS.length - 1)],
    },
  });

  worker.on("completed", (job) => {
    console.log(`[DM Worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[DM Worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message
    );
    void recordWorkerFailure(job, err);
  });

  worker.on("error", (err) => {
    console.error("[DM Worker] Worker error:", err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `DM worker process error: ${err.message}`,
          payload: { name: err.name },
        },
      })
      .catch((recordError) => {
        console.error(
          "[DM Worker] Failed to record worker process error:",
          formatError(recordError)
        );
      });
  });

  return worker;
}
