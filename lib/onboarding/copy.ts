/**
 * The sentences the onboarding cards say.
 *
 * `lib/suggestions` writes the DMs and public replies. It does not write the
 * line that explains a card to the person looking at it, because that line is
 * specific to this screen: it has to name the keyword and the post, which only
 * the engine knows. That sentence lives here.
 *
 * Nothing in this file describes how a post performed. Card copy may say what
 * a post is and what its caption mentions, and may state a comment count
 * Instagram actually returned, and nothing else.
 */

import type { Goal } from "@/lib/suggestions";

/**
 * The end of the card's one-line explanation. It completes:
 *
 *   "Anyone who comments GUIDE on this reel " + tail
 */
const OUTCOME_TAIL: Readonly<Record<Goal, string>> = {
  lead_magnet: "gets the free resource sent straight to their DMs.",
  price_question: "gets your pricing in a DM instead of waiting on you.",
  booking: "gets your booking link in a DM while they are still interested.",
  waitlist: "gets the sign-up link in a DM before the doors open.",
  faq: "gets the full answer in a DM instead of a reply you have typed out a hundred times.",
  thanks: "gets a thank you back, so nobody comments into silence.",
};

/**
 * The card's one plain sentence: what will happen once this is live.
 *
 * `trigger` is the keyword people comment, or null for a campaign that answers
 * every comment regardless of wording.
 */
export function outcomeSentence(
  goal: Goal,
  trigger: string | null,
  target: string
): string {
  const what = trigger === null ? "anything at all" : trigger;
  return `Anyone who comments ${what} on ${target} ${OUTCOME_TAIL[goal]}`;
}
