/**
 * The suggestion engine.
 *
 * Reads a connected Instagram account's recent posts and hands back five
 * complete, ready-to-activate campaign drafts. Complete means a real post, a
 * keyword drawn from that post's caption, a written DM, public reply
 * variations, and every trigger and condition already decided. Nothing here
 * produces a field for someone to fill in.
 *
 * The campaign itself is built by `buildAutomationDraft` in lib/suggestions,
 * which owns the goal catalogue, the copy and the presets. This module owns
 * only the three things that library cannot know: which post a campaign should
 * run on, which goal that post's caption points at, and which five of the
 * possibilities are worth showing.
 *
 * Two rules shape everything below:
 *
 *  - Never invent engagement data. Comment and like counts are used only when
 *    Instagram actually returned them, and no copy claims anything about what
 *    a post's comments contain. What a card says about a post comes from the
 *    caption, which is text the account owner wrote themselves.
 *
 *  - Always return five. A brand new account with no posts is the case this
 *    whole flow exists for, so it gets sensible any-post drafts rather than an
 *    empty state.
 */

import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import {
  DEFAULT_TONE,
  GOAL_CARDS,
  buildAutomationDraft,
  getGoalCard,
  type Goal,
  type Tone,
} from "@/lib/suggestions";
import { outcomeSentence } from "@/lib/onboarding/copy";
import { captionUrl, rankGoals } from "@/lib/onboarding/goal-inference";
import type {
  DraftAutomation,
  DraftPost,
  OnboardingDraft,
  OnboardingSuggestions,
} from "@/lib/onboarding/types";

/** How many drafts a user is ever shown. Five is a choice; ten is a chore. */
export const DRAFT_COUNT = 5;

/**
 * How many posts to read. Twelve is roughly a screen of someone's grid and is
 * a single Graph API page, so there is no pagination cost and no risk of
 * walking an entire back catalogue during onboarding.
 */
export const POSTS_TO_READ = 12;

/** Longest caption fragment shown on a card before it is cut. */
const CAPTION_EXCERPT_LENGTH = 140;

interface SuggestParams {
  /** Decrypted Instagram token for the account being read. */
  accessToken: string;
  account: { id: string; username: string };
  /** The workspace's chosen voice. Every DM is written in it. */
  tone?: Tone;
}

/** What Instagram calls this thing, in words a person would use. */
function mediaLabel(media: InstagramMedia): string {
  if (media.media_product_type === "REELS") return "reel";
  if (media.media_type === "CAROUSEL_ALBUM") return "carousel";
  if (media.media_type === "VIDEO") return "video";
  return "post";
}

function postedOnLabel(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
  });
}

function excerpt(caption: string | undefined): string | null {
  const text = caption?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= CAPTION_EXCERPT_LENGTH
    ? text
    : `${text.slice(0, CAPTION_EXCERPT_LENGTH).trimEnd()}...`;
}

/**
 * Instagram returns counts only sometimes, and only for some media types. An
 * absent count is null rather than zero: zero is a measurement, and claiming
 * one where none was made is exactly what this engine must not do.
 */
function measuredCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toDraftPost(media: InstagramMedia): DraftPost {
  return {
    id: media.id,
    permalink: media.permalink ?? null,
    thumbnailUrl: media.thumbnail_url ?? media.media_url ?? null,
    mediaType: mediaLabel(media),
    captionExcerpt: excerpt(media.caption),
    postedAt: media.timestamp,
    commentsCount: measuredCount(media.comments_count),
    likeCount: measuredCount(media.like_count),
  };
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The sentence under the card describing the post.
 *
 * Describes what the post *is* and what its caption *says*, never how it
 * performed. The one number that may appear is a comment count Instagram
 * actually returned, stated as a plain count and never as a claim about what
 * those comments asked for.
 */
function buildPostContext(
  media: InstagramMedia,
  signals: string[],
  comments: number | null
): string {
  const label = mediaLabel(media);
  const date = postedOnLabel(media.timestamp);
  const parts: string[] = [date ? `Your ${label} from ${date}.` : `Your ${label}.`];

  if (signals.length > 0) {
    parts.push(`The caption mentions ${joinWords(signals)}.`);
  }
  if (comments !== null && comments > 0) {
    parts.push(`It has ${comments} ${comments === 1 ? "comment" : "comments"}.`);
  }

  return parts.join(" ");
}

/**
 * Remove the `{link}` token from copy for a campaign that has no link.
 *
 * Without this the token survives all the way into a stranger's DM: with no
 * tracked link on the campaign, renderMessageWithTracking has nothing to
 * substitute and returns the message with a literal "{link}" still in it.
 *
 * The library writes the token mid-sentence ("here is the guide: {link}. Have
 * a read"), so a naive deletion strands the colon and the space before the
 * full stop. The colon and the loose punctuation are cleaned up too.
 */
export function stripLinkToken(message: string): string {
  const stripped = message
    .replace(/\s*:?\s*\{link\}\s*/gi, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  // A message whose last clause was the link can end mid-sentence.
  return /[.!?]$/.test(stripped) || stripped === ""
    ? stripped
    : `${stripped}.`;
}

interface BuildDraftParams {
  goal: Goal;
  media: InstagramMedia | null;
  signals: string[];
  tone: Tone;
}

/**
 * Assemble one complete draft. Everything the create route needs is decided
 * here, so activation is a post of `draft.automation` and nothing else.
 */
function buildDraft({
  goal,
  media,
  signals,
  tone,
}: BuildDraftParams): OnboardingDraft {
  const card = getGoalCard(goal);
  const caption = media?.caption ?? null;

  // The library builds the campaign itself: name, keywords, copy, conditions,
  // timing. This module never restates any of that.
  const built = buildAutomationDraft({ goal, tone, caption });

  const destinationUrl = captionUrl(caption);
  const hasLink = destinationUrl !== null;

  // A specific post is targeted by id; without one the campaign listens to
  // every post, which is what an account with nothing to point at needs.
  const targetsPost = media !== null;
  const target = targetsPost ? `this ${mediaLabel(media)}` : "any of your posts";

  // The message keeps its {link} token even with no URL yet, because removing
  // it strands the words that pointed at it: "The full answer is here." and
  // "Full pricing is on this page" both survive the deletion and both now
  // reference nothing. Four of five generated drafts read like that.
  //
  // So a link-dependent draft is not silently repaired, it is marked. The
  // activation path installs it paused until a URL exists, which is the same
  // rule the template catalogue already uses, so the product has one answer to
  // this rather than two.
  const dmMessage = built.dmMessage;
  const needsLink = !hasLink && /\{link\}/i.test(dmMessage);

  // A campaign that answers every comment has no keyword to show, and the
  // create route drops the list anyway when matchAnyWord is set.
  const keyword = built.matchAnyWord ? null : (built.keywords[0] ?? null);

  const automation: DraftAutomation = {
    name: built.name,
    goal: built.goal,
    // Resolved from the caller's own workspace at activation, never from a
    // draft, so a draft cannot name another tenant's account.
    instagramAccountId: null,
    postId: targetsPost ? media.id : null,
    postUrl: targetsPost ? (media.permalink ?? null) : null,
    matchAnyPost: !targetsPost,
    keywords: built.keywords,
    matchAnyWord: built.matchAnyWord,
    wholeWordMatch: built.wholeWordMatch,
    dmMessage,
    openingDmEnabled: built.openingDmEnabled,
    publicReplyEnabled: built.publicReplyEnabled,
    publicReplyMessages: built.publicReplyMessages,
    followUpEnabled: built.followUpEnabled,
    followUpDelayMinutes: built.followUpDelayMinutes,
    requireFollow: built.requireFollow,
    // A button with nothing behind it is worse than no button, so the label is
    // kept only when the caption actually gave us a URL to put on it.
    linkButtonLabel: hasLink ? built.linkButtonLabel : null,
    trackedDestinationUrl: destinationUrl,
    // Paused until a link exists, so a campaign never sends a message whose
    // words point at a URL it does not have.
    isActive: built.isActive && !needsLink,
  };

  return {
    id: `${goal}:${media?.id ?? "any"}`,
    goal,
    goalLabel: card.label,
    title: card.label,
    summary: outcomeSentence(goal, keyword, target),
    postContext: media
      ? buildPostContext(media, signals, measuredCount(media.comments_count))
      : null,
    keyword,
    needsLink,
    dmMessage,
    publicReplyMessages: built.publicReplyMessages,
    post: media ? toDraftPost(media) : null,
    automation,
  };
}

interface Candidate {
  media: InstagramMedia;
  goal: Goal;
  signals: string[];
  score: number;
}

/**
 * Score one possible (post, goal) pairing.
 *
 * Confidence dominates, because a caption that plainly asks for bookings is
 * worth more than a recent post that says nothing. Recency is a tiebreaker
 * only. A caption carrying a URL is worth a little more because the resulting
 * draft can actually deliver something rather than only replying. Each step
 * down a post's own goal ranking costs more than recency can make back, so a
 * post's best use is always preferred to its second-best.
 */
function scoreCandidate(
  confidence: number,
  goalRank: number,
  recencyIndex: number,
  postCount: number,
  hasUrl: boolean
): number {
  return (
    confidence * 100 - goalRank * 15 + (postCount - recencyIndex) + (hasUrl ? 5 : 0)
  );
}

/**
 * Pick five drafts that are genuinely different from one another.
 *
 * Diversity is enforced on two axes: no goal appears twice, and no post is
 * used twice. Five variations of the same idea is not a choice, and neither is
 * five campaigns fighting over the same reel.
 *
 * Selection runs in three passes, each a fallback for the one before:
 *   1. Posts whose captions actually signal a goal, best first.
 *   2. Unused goals paired with unused posts, newest first. A post with a
 *      wordless caption still deserves a card with its own thumbnail.
 *   3. Any-post drafts, which need no post at all and are what a brand new
 *      account gets for all five.
 */
function selectDrafts(media: InstagramMedia[], tone: Tone): OnboardingDraft[] {
  const candidates: Candidate[] = [];

  media.forEach((item, index) => {
    const hasUrl = captionUrl(item.caption) !== null;
    rankGoals(item.caption).forEach((inference, goalRank) => {
      candidates.push({
        media: item,
        goal: inference.goal,
        signals: inference.signals,
        score: scoreCandidate(
          inference.confidence,
          goalRank,
          index,
          media.length,
          hasUrl
        ),
      });
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  const drafts: OnboardingDraft[] = [];
  const usedGoals = new Set<Goal>();
  const usedPosts = new Set<string>();

  for (const candidate of candidates) {
    if (drafts.length >= DRAFT_COUNT) break;
    if (usedGoals.has(candidate.goal) || usedPosts.has(candidate.media.id)) {
      continue;
    }
    usedGoals.add(candidate.goal);
    usedPosts.add(candidate.media.id);
    drafts.push(
      buildDraft({
        goal: candidate.goal,
        media: candidate.media,
        signals: candidate.signals,
        tone,
      })
    );
  }

  // Pass two: goals nothing signalled, on posts nothing claimed.
  const spareMedia = media.filter((item) => !usedPosts.has(item.id));
  for (const card of GOAL_CARDS) {
    if (drafts.length >= DRAFT_COUNT) break;
    if (usedGoals.has(card.id)) continue;
    const next = spareMedia.shift();
    if (!next) break;
    usedGoals.add(card.id);
    usedPosts.add(next.id);
    drafts.push(buildDraft({ goal: card.id, media: next, signals: [], tone }));
  }

  // Pass three: no post left to point at, so listen to all of them.
  for (const card of GOAL_CARDS) {
    if (drafts.length >= DRAFT_COUNT) break;
    if (usedGoals.has(card.id)) continue;
    usedGoals.add(card.id);
    drafts.push(buildDraft({ goal: card.id, media: null, signals: [], tone }));
  }

  return drafts;
}

/**
 * Build five ready-to-activate drafts for a connected account.
 *
 * Never throws on a Meta failure and never returns fewer than five drafts. If
 * Instagram cannot be reached, the account still gets a usable set built from
 * the goal catalogue, flagged with `usedFallback` so the screen can say so
 * rather than implying it read captions it never saw.
 */
export async function suggestOnboardingDrafts({
  accessToken,
  account,
  tone = DEFAULT_TONE,
}: SuggestParams): Promise<OnboardingSuggestions> {
  let media: InstagramMedia[] = [];
  let reachedInstagram = true;

  try {
    media = await getUserMedia(accessToken, POSTS_TO_READ);
  } catch (error) {
    // An expired token, a missing permission or a rate limit all land here.
    // None of them is a reason to show an empty screen, which is the single
    // failure this whole flow exists to remove.
    console.warn(
      "[Onboarding] Could not read Instagram media, falling back to any-post drafts:",
      error instanceof Error ? error.message : error
    );
    reachedInstagram = false;
    media = [];
  }

  return {
    drafts: selectDrafts(media, tone),
    account: { id: account.id, username: account.username },
    postsRead: media.length,
    usedFallback: !reachedInstagram || media.length === 0,
  };
}
