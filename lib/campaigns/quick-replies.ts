/**
 * Quick replies as a campaign stores them.
 *
 * Quick replies are the tappable buttons that ride along with a DM. They are
 * how a business answers its most common questions without an AI having to
 * guess: the person taps a button, the button's title is posted to the
 * conversation as their message, and we receive the payload we attached to it.
 *
 * This is the campaign's own data: the storage schema, parsing a stored list
 * back, and which payloads the worker can route. Turning a list into a
 * platform's wire format is the platform's business (lib/meta/quick-replies.ts
 * for Instagram), reached through the channel adapter.
 *
 * The limits are Instagram's, the only platform with quick replies so far:
 *   - at most 13 buttons on one message
 *   - a title is truncated at 20 characters
 *   - "email" and "phone" are prefilled from the tapper's own profile, so they
 *     are a one-tap lead capture rather than something the person has to type
 */

import { z } from "zod";

/** Meta's ceiling on how many quick replies one message can carry. */
export const MAX_QUICK_REPLIES = 13;

/** Meta truncates a quick reply title past this, so we truncate it ourselves. */
export const MAX_QUICK_REPLY_TITLE = 20;

/**
 * The payload is ours and only ever comes back to us as a postback, so it gets
 * the same ceiling the campaign message fields use.
 */
export const MAX_QUICK_REPLY_PAYLOAD = 1000;

/**
 * What a quick reply asks for.
 *
 * "text" is an ordinary tappable answer: it carries a payload that names the
 * follow-up to send. "email" and "phone" are prefilled by Instagram from the
 * tapper's own profile, so they collect a contact detail in one tap and carry
 * no payload of ours.
 */
export type QuickReplyType = "text" | "email" | "phone";

/** One quick reply as a campaign stores it. */
export interface QuickReply {
  title: string;
  type: QuickReplyType;
  /** Required for "text", meaningless for the prefilled types. */
  payload?: string | null;
}

const titleSchema = z
  .string()
  .trim()
  .min(1)
  // Deliberately looser than Meta's 20, because a stored campaign whose title
  // is a little long should still send (truncated) rather than lose its button.
  .max(200);

const payloadSchema = z.string().trim().min(1).max(MAX_QUICK_REPLY_PAYLOAD);

/**
 * One quick reply, validated. A "text" reply must name a follow-up: without a
 * payload the tap tells us nothing, and Meta rejects the button anyway.
 */
export const quickReplySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    title: titleSchema,
    payload: payloadSchema,
  }),
  z.object({
    type: z.literal("email"),
    title: titleSchema,
    payload: payloadSchema.optional().nullable(),
  }),
  z.object({
    type: z.literal("phone"),
    title: titleSchema,
    payload: payloadSchema.optional().nullable(),
  }),
]);

export const quickRepliesSchema = z.array(quickReplySchema).max(MAX_QUICK_REPLIES);

/**
 * Read the quick replies off a campaign row.
 *
 * The column is JSON, so what comes back is genuinely unknown: a campaign
 * written before this field existed holds null, and a hand-edited row can hold
 * anything. Entries that do not validate are dropped rather than failing the
 * whole DM, and the list is capped at Meta's 13, because a campaign that
 * somehow stored more should still send its first thirteen.
 */
export function parseQuickReplies(raw: unknown): QuickReply[] {
  if (!Array.isArray(raw)) return [];

  const replies: QuickReply[] = [];
  for (const entry of raw) {
    const parsed = quickReplySchema.safeParse(entry);
    if (!parsed.success) continue;
    replies.push(parsed.data);
    if (replies.length === MAX_QUICK_REPLIES) break;
  }
  return replies;
}

/**
 * The payload prefixes the DM worker's postback handler already understands.
 * A quick reply payload uses the same vocabulary, so a tap routes into that
 * handler rather than into a parallel path of its own.
 */
export const ROUTABLE_POSTBACK_PREFIXES = ["reveal:", "followcheck:"] as const;

/**
 * Whether a payload names something the postback handler can act on.
 *
 * A payload that does not is not an error. It usually means the campaign author
 * typed a keyword rather than a campaign reference, and the tap still reaches
 * the ordinary keyword path, because Instagram posts the button's title to the
 * conversation as a message.
 */
export function isRoutablePostbackPayload(payload: string): boolean {
  return ROUTABLE_POSTBACK_PREFIXES.some((prefix) => payload.startsWith(prefix));
}
