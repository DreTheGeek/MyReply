/**
 * Reading a caption and deciding what the post is trying to do.
 *
 * This is pattern matching, not a model. Every signal below is something the
 * caption literally says: a link, a currency amount, a booking host, the word
 * "waitlist". Nothing here infers from engagement, and nothing here guesses at
 * an audience. A caption that says none of it returns nothing at all, and the
 * engine falls back to a goal that needs no caption.
 *
 * Goals are the six in `lib/suggestions`. Several distinct caption shapes map
 * onto one goal on purpose: delivering a discount code and delivering a free
 * guide are the same campaign, and a recipe and a frequently asked question
 * are both "they comment, they get the answer".
 */

import type { Goal } from "@/lib/suggestions";

export interface GoalInference {
  goal: Goal;
  /**
   * 0 to 1. How much the caption actually supports this goal, used only to
   * rank drafts against each other. Nothing in here is a claim about the post.
   */
  confidence: number;
  /**
   * The kinds of thing the caption said, for the card's post context. Quoted
   * back to the user, so they only ever describe caption text.
   */
  signals: string[];
}

interface Rule {
  goal: Goal;
  pattern: RegExp;
  weight: number;
  /** What to call this signal when explaining the draft. */
  label: string;
}

/**
 * Booking hosts are the single strongest signal in the set: nobody puts a
 * Calendly link in a caption for any reason other than wanting bookings.
 */
const BOOKING_HOSTS =
  /\b(?:calendly\.com|cal\.com|acuityscheduling\.com|savvycal\.com|booksy\.com|setmore\.com|youcanbook\.me)\b/i;

const RULES: readonly Rule[] = [
  { goal: "booking", pattern: BOOKING_HOSTS, weight: 6, label: "a booking link" },
  {
    goal: "booking",
    pattern:
      /\b(?:book(?:ing|ed)?|appointment|consultation|discovery call|free call|slots?|spots? (?:are )?(?:open|left)|availability)\b/i,
    weight: 3,
    label: "booking language",
  },
  {
    goal: "price_question",
    pattern: /(?:[$£€]\s?\d|\d+\s?(?:usd|gbp|eur|dollars))/i,
    weight: 4,
    label: "a price",
  },
  {
    goal: "price_question",
    pattern:
      /\b(?:pricing|prices?|how much|the cost|costs?|rates?|quote|payment plan|packages?)\b/i,
    weight: 3,
    label: "pricing language",
  },
  {
    goal: "price_question",
    pattern: /\bdm (?:me )?(?:for|to get)\b/i,
    weight: 2,
    label: "an invitation to DM",
  },
  // A code and a guide are the same campaign: they comment, they get the thing.
  {
    goal: "lead_magnet",
    pattern:
      /\b(?:\d{1,2}%\s?off|discount|promo code|coupon|use code|voucher|sale ends|flash sale)\b/i,
    weight: 5,
    label: "a discount",
  },
  {
    goal: "waitlist",
    pattern:
      /\b(?:wait ?list|early access|coming soon|launch(?:es|ing)?|pre-?(?:order|sale)|doors (?:open|close)|enrol?ment|sign ?up)\b/i,
    weight: 4,
    label: "a launch or waitlist",
  },
  {
    goal: "lead_magnet",
    pattern:
      /\b(?:free (?:guide|template|checklist|training|resource|download|copy)|lead magnet|cheat ?sheet|swipe file|workbook|ebook|e-book|pdf|templates?|checklists?|toolkit)\b/i,
    weight: 5,
    label: "a free resource",
  },
  {
    goal: "lead_magnet",
    pattern: /\blink in (?:my )?bio\b/i,
    weight: 2,
    label: "a link in bio",
  },
  // A walkthrough is a question answered in advance, which is what faq sends.
  {
    goal: "faq",
    pattern:
      /\b(?:recipe|how to|step[- ]by[- ]step|steps?:|tutorial|full routine|the method|breakdown|ingredients)\b/i,
    weight: 4,
    label: "a walkthrough",
  },
  {
    goal: "faq",
    pattern:
      /\b(?:collab(?:oration)?|partnership|brand deal|media kit|sponsors?(?:hip|ed)?|ugc)\b/i,
    weight: 3,
    label: "collab language",
  },
  {
    goal: "faq",
    pattern: /\b(?:frequently asked|faq|the question i get|most asked)\b/i,
    weight: 4,
    label: "a question people ask",
  },
];

/** Any http(s) URL. A caption with a link almost always wants it clicked. */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

/** The strongest single weight any rule can carry, used to normalise scores. */
const MAX_WEIGHT = 6;

/**
 * Pull the first URL out of a caption.
 *
 * A campaign's tracked link has to be a real URL the create route will accept,
 * so anything that does not parse is discarded rather than passed along to
 * fail Zod validation at activation time.
 */
export function captionUrl(caption: string | null | undefined): string | null {
  const match = (caption ?? "").match(URL_PATTERN);
  if (!match) return null;
  try {
    return new URL(match[0].replace(/[.,!?;:]+$/, "")).toString();
  } catch {
    return null;
  }
}

/**
 * Rank every goal a caption supports, best first.
 *
 * Returns an empty list for a caption that signals nothing, which is a normal
 * outcome and not an error: plenty of posts are just posts. Diversity needs a
 * second and third choice as well as a winner, so that if three posts all read
 * as pricing, two of them can be built on whatever else their captions support
 * instead of being dropped.
 */
export function rankGoals(caption: string | null | undefined): GoalInference[] {
  const text = caption ?? "";
  const scores = new Map<Goal, number>();
  const signals = new Map<Goal, string[]>();

  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    scores.set(rule.goal, (scores.get(rule.goal) ?? 0) + rule.weight);
    const list = signals.get(rule.goal) ?? [];
    if (!list.includes(rule.label)) list.push(rule.label);
    signals.set(rule.goal, list);
  }

  // A bare link with no other signal means "they want this clicked", which is
  // a lead magnet in everything but name. Weak on purpose, so any rule that
  // actually names an intent beats it.
  if (captionUrl(text) && scores.size === 0) {
    scores.set("lead_magnet", 2);
    signals.set("lead_magnet", ["a link"]);
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([goal, score]) => ({
      goal,
      confidence: Math.min(score / MAX_WEIGHT, 1),
      signals: signals.get(goal) ?? [],
    }));
}

/**
 * The single best reading of a caption, or null when it signals nothing.
 *
 * Null rather than a low-confidence guess: a caption that says nothing has not
 * told us anything, and inventing an intent for it is the same mistake as
 * inventing engagement data.
 */
export function inferGoal(caption: string | null | undefined): GoalInference | null {
  return rankGoals(caption)[0] ?? null;
}
