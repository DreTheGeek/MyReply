import { z } from "zod";

/**
 * Shared vocabulary for the suggestion library.
 *
 * The governing rule for everything under lib/suggestions: never show a blank
 * input. Every blank in the product is answered here with a list of good
 * options, so the customer picks instead of thinks.
 *
 * This file is deliberately a leaf. It imports Zod and nothing else, so a
 * server component, a route handler, a worker and a test can all agree on the
 * same ids without dragging Prisma or NextAuth in behind them.
 */

/**
 * What the owner is trying to get out of a campaign. These are the cards the
 * onboarding shows instead of a form, so the list stays short on purpose. Six
 * is already the top of what a person will read before they start guessing.
 */
export const GOAL_IDS = [
  "lead_magnet",
  "price_question",
  "booking",
  "waitlist",
  "faq",
  "thanks",
] as const;

export type Goal = (typeof GOAL_IDS)[number];

export const goalSchema = z.enum(GOAL_IDS);

export function isGoal(value: unknown): value is Goal {
  return goalSchema.safeParse(value).success;
}

/**
 * The voice every suggested message is written in. Picked once per workspace
 * and inherited everywhere after that, so nobody is asked the same question on
 * their second campaign.
 */
export const TONE_IDS = [
  "friendly",
  "professional",
  "hype",
  "short",
  "warm",
] as const;

export type Tone = (typeof TONE_IDS)[number];

export const toneSchema = z.enum(TONE_IDS);

export function isTone(value: unknown): value is Tone {
  return toneSchema.safeParse(value).success;
}

/** What a workspace gets when it has never chosen. */
export const DEFAULT_TONE: Tone = "friendly";

/**
 * The two substitutions the sender understands. See lib/tracking/message.ts:
 * `{username}` becomes the commenter's name, or "there" when Instagram gives
 * us nothing, and `{link}` becomes the tracked redirect. Any other brace token
 * would be delivered to a real person verbatim, which is why the tests assert
 * that no message in this library contains one.
 */
export const KNOWN_PLACEHOLDERS = ["{username}", "{link}"] as const;

export type KnownPlaceholder = (typeof KNOWN_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{[^{}]*\}/g;

/** Every brace token in a message, lowercased, in order of appearance. */
export function extractPlaceholders(message: string): string[] {
  return (message.match(PLACEHOLDER_PATTERN) ?? []).map((token) =>
    token.toLowerCase()
  );
}

/** Brace tokens the sender would not substitute. Empty means the copy is safe. */
export function findUnknownPlaceholders(message: string): string[] {
  const known = new Set<string>(KNOWN_PLACEHOLDERS);
  return extractPlaceholders(message).filter((token) => !known.has(token));
}
