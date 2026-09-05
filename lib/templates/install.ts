import { z } from "zod";
import type { CampaignTemplateDefinition } from "@/lib/templates/catalogue";

/**
 * What an install needs from the caller, and nothing more.
 *
 * Every field is optional on purpose. The governing rule for templates is that
 * a choice is a pick and never a think, so a workspace with one connected
 * account and no post in mind can post an empty body and still get a working
 * campaign: the newest connected account, and "any post".
 */
export const templateInstallInputSchema = z.object({
  /** Which connected account. Omitted means the most recently connected one. */
  instagramAccountId: z.string().min(1).optional().nullable(),
  /** A specific post or reel. Omitted means the campaign watches any post. */
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  /** Explicitly ask for "any post" even when a postId was sent. */
  matchAnyPost: z.boolean().optional(),
  /** Where the DM button points. Omitted leaves a link template switched off. */
  destinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  /** Rename the campaign on the way in. The template's own name is default. */
  name: z.string().min(1).max(100).optional().nullable(),
});

export type TemplateInstallInput = z.infer<typeof templateInstallInputSchema>;

/**
 * The body POST /api/automations accepts. Named separately from the route's
 * own Zod schema so the shape is importable by a test without importing the
 * route, while the route's schema stays the only validator.
 */
export interface TemplateInstallPayload {
  name: string;
  goal: string;
  instagramAccountId: string;
  postId: string | null;
  postUrl: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  dmTriggerEnabled: boolean;
  storyReplyEnabled: boolean;
  storyMentionEnabled: boolean;
  liveCommentEnabled: boolean;
  defaultReplyEnabled: boolean;
  referralRef: string | null;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  linkButtonLabel: string | null;
  requireFollow: boolean;
  followPromptMessage: string | null;
  followPromptButtonLabel: string | null;
  followUpEnabled: boolean;
  followUpMessage: string | null;
  followUpDelayMinutes: number;
  publicReplyEnabled: boolean;
  publicReplyMessages: string[];
  trackedDestinationUrl: string | null;
  isActive: boolean;
  wholeWordMatch: boolean;
}

/**
 * Turn a template plus a target into the exact body the campaign create route
 * accepts. No validation happens here: the route's own schema is the single
 * validator, and this only decides defaults.
 */
export function buildInstallPayload(
  template: CampaignTemplateDefinition,
  input: TemplateInstallInput & { instagramAccountId: string }
): TemplateInstallPayload {
  const { preset } = template;

  // A post only means something to a template that watches posts. The
  // default-reply, story-reply and referral templates have no post to bind to,
  // so a postId sent alongside one is ignored rather than quietly breaking the
  // trigger the template depends on.
  const usesPostTrigger = preset.matchAnyPost;
  const wantsSpecificPost =
    usesPostTrigger && input.matchAnyPost !== true && Boolean(input.postId);

  const destinationUrl = input.destinationUrl?.trim() || null;

  return {
    name: input.name?.trim() || template.name,
    goal: template.goal,
    instagramAccountId: input.instagramAccountId,
    postId: wantsSpecificPost ? (input.postId ?? null) : null,
    postUrl: wantsSpecificPost ? (input.postUrl ?? null) : null,
    pendingNextReel: false,
    matchAnyPost: usesPostTrigger && !wantsSpecificPost,
    keywords: preset.matchAnyWord ? [] : [...preset.keywords],
    matchAnyWord: preset.matchAnyWord,
    dmTriggerEnabled: preset.dmTriggerEnabled,
    storyReplyEnabled: preset.storyReplyEnabled,
    storyMentionEnabled: preset.storyMentionEnabled,
    liveCommentEnabled: preset.liveCommentEnabled,
    defaultReplyEnabled: preset.defaultReplyEnabled,
    referralRef: preset.referralRef,
    dmMessage: preset.dmMessage,
    openingDmEnabled: preset.openingDmEnabled,
    openingDmMessage: preset.openingDmMessage,
    openingDmButtonLabel: preset.openingDmButtonLabel,
    linkButtonLabel: preset.linkButtonLabel,
    requireFollow: preset.requireFollow,
    followPromptMessage: preset.followPromptMessage,
    followPromptButtonLabel: preset.followPromptButtonLabel,
    followUpEnabled: preset.followUpEnabled,
    followUpMessage: preset.followUpMessage,
    followUpDelayMinutes: preset.followUpDelayMinutes,
    publicReplyEnabled: preset.publicReplyEnabled,
    publicReplyMessages: [...preset.publicReplyMessages],
    trackedDestinationUrl: destinationUrl,
    // A template whose DM only works with a link installs switched off until
    // there is one. The alternative is a live campaign that promises a button
    // it cannot show, which is worse than a campaign that has not started.
    isActive: !template.needsLink || Boolean(destinationUrl),
    wholeWordMatch: preset.wholeWordMatch,
  };
}
