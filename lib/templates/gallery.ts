import {
  type CampaignTemplateDefinition,
  getTemplatesByGroup,
} from "@/lib/templates/catalogue";

/** One catalogue entry, flattened to what a card actually renders. */
export interface GalleryTemplate {
  slug: string;
  name: string;
  description: string;
  audience: string;
  goal: string;
  needsLink: boolean;
  /** The words that set it off, or what fires it when there are no keywords. */
  keywordLabel: string;
  /** Where it listens: any post, story replies, unanswered DMs, new chats. */
  triggerLabel: string;
  /** The exact DM this will send, so nothing is a surprise after the tap. */
  dmMessage: string;
}

export interface GallerySection {
  id: string;
  label: string;
  description: string;
  templates: GalleryTemplate[];
}

/**
 * Where the campaign listens, in the words someone would use to describe it.
 * Read off the same preset flags the install writes, so the card cannot claim
 * a trigger the campaign will not have.
 */
export function describeTrigger(template: CampaignTemplateDefinition): string {
  const { preset } = template;
  const parts: string[] = [];

  if (preset.matchAnyPost) parts.push("Comments on any post");
  if (preset.storyReplyEnabled) parts.push("Story replies");
  if (preset.storyMentionEnabled) parts.push("Story mentions");
  if (preset.liveCommentEnabled) parts.push("Live comments");
  if (preset.defaultReplyEnabled) parts.push("DMs nothing else answered");
  else if (preset.dmTriggerEnabled) parts.push("Direct messages");
  if (preset.referralRef) parts.push("Chats opened from your link");

  return parts.join(" and ");
}

/** The keywords as a card shows them, or what happens when there are none. */
export function describeKeywords(
  template: CampaignTemplateDefinition
): string {
  if (template.preset.matchAnyWord) return "Any message";
  return template.preset.keywords.join(", ");
}

/** The catalogue as the in-app gallery renders it, grouped and flattened. */
export function buildGallerySections(): GallerySection[] {
  return getTemplatesByGroup().map(({ group, templates }) => ({
    id: group.id,
    label: group.label,
    description: group.description,
    templates: templates.map((template) => ({
      slug: template.slug,
      name: template.name,
      description: template.description,
      audience: template.audience,
      goal: template.goal,
      needsLink: template.needsLink,
      keywordLabel: describeKeywords(template),
      triggerLabel: describeTrigger(template),
      dmMessage: template.preset.dmMessage,
    })),
  }));
}
