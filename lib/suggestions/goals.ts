import { suggestKeywords, GOAL_KEYWORDS } from "./keywords";
import { suggestMessage, suggestPublicReplies } from "./messages";
import type { ConditionId, FollowUpTimingId } from "./presets";
import { clampFollowUpDelayMinutes } from "./presets";
import type { Goal, Tone } from "./types";
import { DEFAULT_TONE, GOAL_IDS } from "./types";

/**
 * The goal catalogue.
 *
 * Onboarding shows these cards instead of a form. The owner taps one and a
 * campaign is already 90 percent filled in, because every field on the card
 * below maps to a real column on Automation. Nothing here is aspirational: if
 * a field is not in prisma/schema.prisma it does not appear on this type.
 */

/**
 * The Automation columns a goal card presets. Every key is a real column, see
 * the Automation model in prisma/schema.prisma.
 *
 * Two deliberate absences:
 * - `openingDmEnabled` stays false everywhere. The create route refuses an
 *   opening DM without both a message and a button label, so a goal that
 *   flipped it on by default would hand the onboarding a payload that fails
 *   validation.
 * - `followUpEnabled` stays false for the same reason in spirit. A follow-up
 *   with no follow-up message written is an empty DM. The delay is still
 *   preset, so the moment the owner writes one and flips the toggle, the timing
 *   is already the right timing.
 */
export interface GoalAutomationPresets {
  /** Automation.goal, the human label stored on the row. */
  goal: string;
  /** Automation.keywords. */
  keywords: string[];
  /** Automation.matchAnyWord. */
  matchAnyWord: boolean;
  /** Automation.wholeWordMatch. */
  wholeWordMatch: boolean;
  /** Automation.linkButtonLabel, capped at 20 characters by the create route. */
  linkButtonLabel: string | null;
  /** Automation.requireFollow. */
  requireFollow: boolean;
  /** Automation.openingDmEnabled. */
  openingDmEnabled: boolean;
  /** Automation.followUpEnabled. */
  followUpEnabled: boolean;
  /** Automation.followUpDelayMinutes, already clamped to the safe ceiling. */
  followUpDelayMinutes: number;
  /** Automation.publicReplyEnabled. */
  publicReplyEnabled: boolean;
  /** Automation.isActive. */
  isActive: boolean;
}

export interface GoalCard {
  id: Goal;
  /** What the card says. Four words at most. */
  label: string;
  /** One line under the label. What the owner gets, not how it works. */
  description: string;
  /** A comment a real person would leave to trigger this. Shown as proof. */
  example: string;
  /** The starting keyword chips before any caption is read. */
  defaultKeywords: string[];
  /** The Automation columns this card fills in. */
  presets: GoalAutomationPresets;
  /** Timing to offer if the owner turns a follow-up on. */
  suggestedFollowUpTiming: FollowUpTimingId;
  /** Conditions worth offering for this goal, in the order to show them. */
  suggestedConditions: readonly ConditionId[];
}

function presets(
  goal: string,
  keywords: readonly string[],
  overrides: Partial<GoalAutomationPresets> = {}
): GoalAutomationPresets {
  return {
    goal,
    keywords: [...keywords],
    matchAnyWord: false,
    wholeWordMatch: true,
    linkButtonLabel: null,
    requireFollow: false,
    openingDmEnabled: false,
    followUpEnabled: false,
    followUpDelayMinutes: 0,
    publicReplyEnabled: true,
    isActive: true,
    ...overrides,
  };
}

export const GOAL_CARDS: readonly GoalCard[] = [
  {
    id: "lead_magnet",
    label: "Send my free guide",
    description: "Someone asks for the freebie and it lands in their DMs seconds later.",
    example: "GUIDE please",
    defaultKeywords: [...GOAL_KEYWORDS.lead_magnet],
    presets: presets("Lead magnet delivery", GOAL_KEYWORDS.lead_magnet, {
      linkButtonLabel: "Get the guide",
      followUpDelayMinutes: clampFollowUpDelayMinutes(60),
    }),
    suggestedFollowUpTiming: "in_an_hour",
    suggestedConditions: ["first_time", "already_follows", "vip"],
  },
  {
    id: "price_question",
    label: "Answer price questions",
    description: "Stop typing the same number under every post. Send the page instead.",
    example: "how much?",
    defaultKeywords: [...GOAL_KEYWORDS.price_question],
    presets: presets("Pricing request", GOAL_KEYWORDS.price_question, {
      linkButtonLabel: "See pricing",
      followUpDelayMinutes: clampFollowUpDelayMinutes(60),
    }),
    suggestedFollowUpTiming: "in_an_hour",
    suggestedConditions: ["first_time", "clicked_before", "vip"],
  },
  {
    id: "booking",
    label: "Get calls booked",
    description: "Turn a comment into a slot on your calendar without a back and forth.",
    example: "BOOK",
    defaultKeywords: [...GOAL_KEYWORDS.booking],
    presets: presets("Booking request", GOAL_KEYWORDS.booking, {
      linkButtonLabel: "Book a time",
      followUpDelayMinutes: clampFollowUpDelayMinutes(16 * 60),
    }),
    suggestedFollowUpTiming: "tomorrow_morning",
    suggestedConditions: ["first_time", "clicked_before", "verified"],
  },
  {
    id: "waitlist",
    label: "Build a waitlist",
    description: "Collect the people who want in before you have anything to sell them.",
    example: "WAITLIST me",
    defaultKeywords: [...GOAL_KEYWORDS.waitlist],
    presets: presets("Waitlist signup", GOAL_KEYWORDS.waitlist, {
      linkButtonLabel: "Join the waitlist",
      followUpDelayMinutes: clampFollowUpDelayMinutes(16 * 60),
    }),
    suggestedFollowUpTiming: "tomorrow_morning",
    suggestedConditions: ["first_time", "vip", "already_follows"],
  },
  {
    id: "faq",
    label: "Answer the same question",
    description: "The question you get twenty times a week, answered once and sent forever.",
    example: "does it work for beginners",
    defaultKeywords: [...GOAL_KEYWORDS.faq],
    presets: presets("Common question", GOAL_KEYWORDS.faq, {
      linkButtonLabel: "Read the answer",
      followUpDelayMinutes: 0,
    }),
    suggestedFollowUpTiming: "right_away",
    suggestedConditions: ["first_time", "clicked_before"],
  },
  {
    id: "thanks",
    label: "Say thank you",
    description: "Reply to everyone who took the time, so nobody comments into silence.",
    example: "this helped a lot",
    defaultKeywords: [...GOAL_KEYWORDS.thanks],
    presets: presets("Thank you reply", GOAL_KEYWORDS.thanks, {
      // The point of this one is that it answers everybody, so it matches any
      // word rather than waiting for a specific one. The create route accepts
      // that: a campaign needs matchAnyWord or at least one keyword, and this
      // carries both.
      matchAnyWord: true,
      linkButtonLabel: null,
      followUpDelayMinutes: 0,
    }),
    suggestedFollowUpTiming: "right_away",
    suggestedConditions: ["vip", "verified", "first_time"],
  },
] as const;

export function listGoalCards(): readonly GoalCard[] {
  return GOAL_CARDS;
}

export function getGoalCard(id: Goal): GoalCard {
  const card = GOAL_CARDS.find((candidate) => candidate.id === id);
  // GOAL_CARDS covers GOAL_IDS and a test asserts it. The fallback keeps a bad
  // cast at a call site from blanking the onboarding screen.
  return card ?? GOAL_CARDS[0];
}

/**
 * Everything needed to create an Automation, with no blanks left.
 *
 * Every key is a column on the Automation model. Hand this straight to
 * POST /api/automations once the account, post and tracked link are attached.
 */
export interface AutomationDraft {
  name: string;
  goal: string;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  dmMessage: string;
  linkButtonLabel: string | null;
  requireFollow: boolean;
  openingDmEnabled: boolean;
  followUpEnabled: boolean;
  followUpDelayMinutes: number;
  publicReplyEnabled: boolean;
  publicReplyMessages: string[];
  isActive: boolean;
}

export interface AutomationDraftInput {
  goal: Goal;
  /** The workspace tone. Defaults to friendly, the same as the column does. */
  tone?: Tone;
  /** The caption of the post this campaign runs on, when one is chosen yet. */
  caption?: string | null;
  /** Which of the written messages to use. Wraps, so "show me another" is free. */
  messageIndex?: number;
  /** Overrides the generated campaign name. */
  name?: string;
}

/**
 * Build a complete campaign from one tap on a goal card.
 *
 * This is the function that makes the design law hold: the owner picks a goal,
 * and every field the form would have asked them for already has a real answer
 * in it. They edit what they disagree with, which is usually nothing.
 */
export function buildAutomationDraft(input: AutomationDraftInput): AutomationDraft {
  const card = getGoalCard(input.goal);
  const tone = input.tone ?? DEFAULT_TONE;

  return {
    name: input.name?.trim() || card.label,
    goal: card.presets.goal,
    keywords: suggestKeywords(input.caption ?? null, input.goal),
    matchAnyWord: card.presets.matchAnyWord,
    wholeWordMatch: card.presets.wholeWordMatch,
    dmMessage: suggestMessage(input.goal, tone, input.messageIndex ?? 0),
    linkButtonLabel: card.presets.linkButtonLabel,
    requireFollow: card.presets.requireFollow,
    openingDmEnabled: card.presets.openingDmEnabled,
    followUpEnabled: card.presets.followUpEnabled,
    followUpDelayMinutes: clampFollowUpDelayMinutes(card.presets.followUpDelayMinutes),
    publicReplyEnabled: card.presets.publicReplyEnabled,
    // The create route accepts at most 10 variations.
    publicReplyMessages: suggestPublicReplies(input.goal).slice(0, 10),
    isActive: card.presets.isActive,
  };
}

export { GOAL_IDS };
export type { Goal, Tone };
