import { z } from "zod";
import { CAPTURE_KINDS, MAX_CAPTURE_TEXT } from "@/lib/campaigns/capture";

/**
 * The request shapes for creating and changing a campaign. Kept here rather
 * than in the route so the dashboard route, the v1 API and the OpenAPI
 * document all read one definition: a Next.js route file may only export its
 * handlers.
 */

/**
 * A destination we are willing to send a customer to.
 *
 * z.string().url() accepts any scheme, so "javascript:alert(1)",
 * "data:text/html,x" and "file:///etc/passwd" all passed and were stored as
 * tracked destinations. A Location header will not execute those, so this was
 * never code execution, but app/api/automations/import already validated
 * ^https?:// on the same field and the two paths disagreed.
 */
export const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Only http and https links can be sent to a customer",
  });

export const createAutomationSchema = z
  .object({
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    postId: z.string().min(1).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmTriggerEnabled: z.boolean().optional().default(false),
    storyReplyEnabled: z.boolean().optional().default(false),
    storyMentionEnabled: z.boolean().optional().default(false),
    liveCommentEnabled: z.boolean().optional().default(false),
    defaultReplyEnabled: z.boolean().optional().default(false),
    // Empty string means "no ref"; it is stored as null so an unused ref never
    // collides with another campaign's.
    referralRef: z.string().max(100).optional().nullable(),
    dmMessage: z.string().min(1).max(1000),
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(64).optional().nullable(),
    linkButtonLabel: z.string().max(20).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    // Minutes to wait before the follow-up. Capped at 24h so it stays inside
    // Instagram's messaging window.
    followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    // Empty string means "no tracked link"; a URL sets one.
    trackedDestinationUrl: z.union([httpUrl, z.literal("")])
      .optional()
      .nullable(),
    // Optional second tracked link, rendered as a second DM button.
    secondaryDestinationUrl: z.union([httpUrl, z.literal("")])
      .optional()
      .nullable(),
    secondaryButtonLabel: z.string().max(20).optional().nullable(),
    // Ask for an email or phone number after the campaign's message.
    captureEnabled: z.boolean().optional().default(false),
    captureKinds: z.array(z.enum(CAPTURE_KINDS)).max(CAPTURE_KINDS.length).optional().default([]),
    capturePrompt: z.string().max(MAX_CAPTURE_TEXT).optional().nullable(),
    captureConsentText: z.string().max(MAX_CAPTURE_TEXT).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
  })
  // A campaign must target a specific post, any post, or the next reel, unless
  // it fires from somewhere a post never applies: a DM, a story, a live, the
  // default-reply fallback, or a referral ref.
  .refine(
    (d) =>
      d.matchAnyPost ||
      d.pendingNextReel ||
      Boolean(d.postId) ||
      d.dmTriggerEnabled ||
      d.storyReplyEnabled ||
      d.storyMentionEnabled ||
      d.liveCommentEnabled ||
      d.defaultReplyEnabled ||
      Boolean(d.referralRef?.trim()),
    {
      message: "Choose which post(s) trigger the campaign, or turn on another trigger",
      path: ["postId"],
    }
  )
  // And it must match either specific words or any word.
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  )
  .refine((d) => !d.captureEnabled || d.captureKinds.length > 0, {
    message: "Choose email, phone or both to ask for",
    path: ["captureKinds"],
  });

export const updateAutomationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  instagramAccountId: z.string().min(1).optional(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  storyReplyEnabled: z.boolean().optional(),
  storyMentionEnabled: z.boolean().optional(),
  liveCommentEnabled: z.boolean().optional(),
  defaultReplyEnabled: z.boolean().optional(),
  referralRef: z.string().max(100).optional().nullable(),
  dmMessage: z.string().min(1).max(1000).optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  captureEnabled: z.boolean().optional(),
  captureKinds: z.array(z.enum(CAPTURE_KINDS)).max(CAPTURE_KINDS.length).optional(),
  capturePrompt: z.string().max(MAX_CAPTURE_TEXT).optional().nullable(),
  captureConsentText: z.string().max(MAX_CAPTURE_TEXT).optional().nullable(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: z.union([httpUrl, z.literal("")])
    .optional()
    .nullable(),
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: z.union([httpUrl, z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
});

/** One campaign in a batch import. */
export const importCampaignSchema = z.object({
  postId: z.string().min(1),
  postUrl: z.string().optional().nullable(),
  keywords: z.array(z.string().min(1).max(50)).min(1).max(10),
  dmMessage: z.string().min(1).max(1000),
  name: z.string().max(100).optional().nullable(),
  goal: z.string().max(120).optional().nullable(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  trackedUrl: z.string().optional().nullable(),
  wholeWordMatch: z.boolean().optional().default(true),
  isActive: z.boolean().optional().default(true),
});

export const importCampaignsSchema = z.object({
  instagramAccountId: z.string().min(1),
  campaigns: z.array(importCampaignSchema).min(1).max(200),
});
