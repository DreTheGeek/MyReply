/**
 * Per-workspace settings for customer answering, and the auto-pause rule.
 *
 * Two pieces of state with two different homes, for two different reasons.
 *
 * SETTINGS live as an append-only journal in OperationalEvent, newest row wins.
 * The knowledge schema is fixed and carries no settings table, and of the
 * workspace-scoped tables that exist, OperationalEvent is the one with a JSON
 * payload and an already-correct meaning: "something happened in this workspace
 * that an operator may want to see". Turning automated answering on, or moving
 * the threshold that decides whether a model talks to customers unsupervised,
 * is exactly that. Append-only also buys the audit trail for free: who changed
 * the threshold, to what, and when, is a query rather than a lost fact, which a
 * mutable settings column would not have given us. Rows are written with
 * `resolvedAt` already set so they never appear in the portal's open-issues
 * feed, which filters on `resolvedAt: null`.
 *
 * AUTO-PAUSE is not stored at all. It is derived from OutboundMessage rows with
 * `source: MANUAL`, which the messages webhook already writes for every message
 * the connected account sends that MyReply did not send itself. That is a
 * strictly better signal than a pause flag we would set from our own UI: it
 * catches an operator replying from the Instagram app on their phone, which is
 * where most manual replies are actually typed, and no flag we own could see
 * that. Derived state also cannot go stale, cannot leak across a redeploy, and
 * expires on its own the moment the window passes. The existing
 * `[instagramAccountId, recipientId, sentAt]` index is exactly the lookup.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";

/**
 * The message field that identifies a settings row. Matched exactly, so an
 * operator event with similar prose can never be read back as configuration.
 */
export const ANSWERING_SETTINGS_EVENT = "assistant.answering.settings";

export interface AnsweringSettings {
  /** Off until a human turns it on. Automation that talks to customers opts in. */
  enabled: boolean;
  /** 0 to 1. At or above it the answer sends; below it a human gets it. */
  confidenceThreshold: number;
  /** Minutes of silence from the assistant after a human replies. 0 disables. */
  autoPauseMinutes: number;
  /** Appended to every sent answer. Empty string sends nothing extra. */
  disclosure: string;
}

/**
 * 0.6 as the default threshold is chosen against the score's own shape rather
 * than picked out of the air. Confidence is the geometric mean of retrieval
 * coverage and answer groundedness, so 0.6 is the line where both halves are
 * around 0.6, or one is strong and the other is merely adequate. A well
 * supported answer lands near 0.8; an answer stitched from thin retrieval lands
 * near 0.4.
 *
 * 30 minutes of auto-pause matches what operators already expect from ManyChat.
 *
 * The disclosure defaults on and is not conditional on where the customer is.
 * Meta requires disclosure of automation to users in Canada and Germany, and an
 * Instagram DM carries no reliable country for the person on the other end, so
 * the only setting that is compliant by construction is "always".
 */
export const DEFAULT_ANSWERING_SETTINGS: AnsweringSettings = {
  enabled: false,
  confidenceThreshold: 0.6,
  autoPauseMinutes: 30,
  disclosure: "Sent automatically by our assistant. Reply and a person will take over.",
};

export const MAX_DISCLOSURE_LENGTH = 200;
export const MAX_AUTO_PAUSE_MINUTES = 1440;

/**
 * Both the write schema for the route and the read schema for the stored
 * payload. A row written by an older shape parses into whatever it still
 * satisfies and the rest falls back to the defaults.
 */
export const answeringSettingsSchema = z.object({
  enabled: z.boolean(),
  confidenceThreshold: z.number().min(0).max(1),
  autoPauseMinutes: z.number().int().min(0).max(MAX_AUTO_PAUSE_MINUTES),
  disclosure: z.string().max(MAX_DISCLOSURE_LENGTH),
});

/** Read side. Every field optional, so a partial payload still yields settings. */
const storedSettingsSchema = answeringSettingsSchema.partial();

export async function getAnsweringSettings(
  workspaceId: string
): Promise<AnsweringSettings> {
  const row = await prisma.operationalEvent.findFirst({
    where: {
      workspaceId,
      source: "SYSTEM",
      message: ANSWERING_SETTINGS_EVENT,
    },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });

  if (!row) return { ...DEFAULT_ANSWERING_SETTINGS };

  const parsed = storedSettingsSchema.safeParse(row.payload);
  if (!parsed.success) {
    // A malformed row is a bug in a writer, not a reason to start answering
    // customers on unknown settings. Fall back to the safe defaults, which have
    // answering off.
    console.error("[answering] stored settings did not parse", { workspaceId });
    return { ...DEFAULT_ANSWERING_SETTINGS };
  }

  return { ...DEFAULT_ANSWERING_SETTINGS, ...parsed.data };
}

export interface SaveAnsweringSettingsInput {
  workspaceId: string;
  settings: AnsweringSettings;
  /** Audit only. Recorded, never used to grant anything. */
  updatedByUserId?: string | null;
}

export async function saveAnsweringSettings(
  input: SaveAnsweringSettingsInput
): Promise<AnsweringSettings> {
  const settings = answeringSettingsSchema.parse(input.settings);

  await prisma.operationalEvent.create({
    data: {
      workspaceId: input.workspaceId,
      source: "SYSTEM",
      level: "INFO",
      message: ANSWERING_SETTINGS_EVENT,
      payload: {
        ...settings,
        updatedByUserId: input.updatedByUserId ?? null,
      },
      // Configuration, not an incident. Resolved on arrival so it stays out of
      // the portal's open-issues list.
      resolvedAt: new Date(),
    },
  });

  return settings;
}

export interface AutoPauseCheck {
  instagramAccountId: string;
  /** The customer's IGSID, which is what OutboundMessage records. */
  recipientId: string;
  autoPauseMinutes: number;
  now: Date;
}

/**
 * True when a human replied to this person recently enough that the assistant
 * must stay quiet.
 *
 * MANUAL is the whole point of the filter: an AUTOMATION echo is MyReply's own
 * message coming back, and pausing on our own send would mean the assistant
 * silences itself after every answer it gives.
 */
export async function isPausedByHuman(check: AutoPauseCheck): Promise<boolean> {
  if (check.autoPauseMinutes <= 0) return false;

  const since = new Date(check.now.getTime() - check.autoPauseMinutes * 60_000);

  const recent = await prisma.outboundMessage.count({
    where: {
      instagramAccountId: check.instagramAccountId,
      recipientId: check.recipientId,
      source: "MANUAL",
      sentAt: { gte: since },
    },
  });

  return recent > 0;
}
