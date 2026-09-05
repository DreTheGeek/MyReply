/**
 * What a finished onboarding suggestion is.
 *
 * A draft is not a form to fill in. It is a campaign that is already complete:
 * a real post, a keyword drawn from that post's caption, a written DM, public
 * reply variations, and every trigger and condition already decided. The only
 * required interaction is Activate.
 */

import type { Goal } from "@/lib/suggestions";

/**
 * The campaign payload, field for field as `POST /api/automations` accepts it.
 *
 * Deliberately not a partial or a looser shape: activation posts this object
 * straight at the existing create route, so if this drifts from that route's
 * Zod schema the compiler and that route's own validation both say so, rather
 * than a draft quietly failing at the moment someone taps Activate.
 */
export interface DraftAutomation {
  name: string;
  goal: string;
  /**
   * Always null in a draft as it leaves the engine. Activation resolves the
   * account from the caller's own workspace instead, so a draft can never name
   * another tenant's account.
   */
  instagramAccountId: string | null;
  postId: string | null;
  postUrl: string | null;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  dmMessage: string;
  publicReplyEnabled: boolean;
  publicReplyMessages: string[];
  openingDmEnabled: boolean;
  followUpEnabled: boolean;
  followUpDelayMinutes: number;
  requireFollow: boolean;
  linkButtonLabel: string | null;
  trackedDestinationUrl: string | null;
  isActive: boolean;
}

/**
 * The post a draft is built on, as the card renders it.
 *
 * `commentsCount` and `likeCount` are whatever Instagram actually returned and
 * are null when it returned nothing. They are never estimated, and no copy
 * anywhere derives a claim about a post's performance from a null.
 */
export interface DraftPost {
  id: string;
  permalink: string | null;
  thumbnailUrl: string | null;
  mediaType: string;
  captionExcerpt: string | null;
  postedAt: string;
  commentsCount: number | null;
  likeCount: number | null;
}

export interface OnboardingDraft {
  /** Stable for a given account and post, so re-fetching does not reshuffle. */
  id: string;
  goal: Goal;
  /** The goal's plain-language category, e.g. "Answer a pricing question". */
  goalLabel: string;
  /** The card's heading. Short, names the outcome. */
  title: string;
  /** One plain sentence: exactly what will happen once this is live. */
  summary: string;
  /**
   * A sentence about the post itself, never about how it performed. Null on an
   * any-post draft, which is not tied to a single post.
   */
  postContext: string | null;
  /**
   * The keyword shown on the card, or null for a campaign that answers every
   * comment regardless of wording, which has no single word to show.
   */
  keyword: string | null;
  /**
   * True when the message points at a link the account has not given us. The
   * draft still activates, but paused, because the alternative is sending
   * "Full pricing is on this page" to a stranger with no page attached. The
   * card says so and offers the one field this product genuinely cannot guess.
   */
  needsLink: boolean;
  /** The DM shown on the card, exactly as it will be sent. */
  dmMessage: string;
  publicReplyMessages: string[];
  post: DraftPost | null;
  automation: DraftAutomation;
}

/** What the suggestions endpoint returns. */
export interface OnboardingSuggestions {
  /** Always five, on every account, including one with no posts at all. */
  drafts: OnboardingDraft[];
  account: {
    id: string;
    username: string;
  };
  /** How many posts the engine actually read. Zero is a normal, handled case. */
  postsRead: number;
  /**
   * True when drafts were built without reading Instagram, either because the
   * account has no posts or because Meta could not be reached. The screen says
   * so plainly rather than pretending the drafts came from their captions.
   */
  usedFallback: boolean;
}
