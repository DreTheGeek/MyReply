/**
 * The installable template registry.
 *
 * Every entry here is a complete campaign, not a brochure. Each one maps onto
 * real `Automation` columns from prisma/schema.prisma and is written so that a
 * single tap in the gallery produces a campaign the owner could have built by
 * hand, with copy that is ready to go to a real audience.
 *
 * Two rules govern the words:
 *
 *   1. The only placeholders are {username} and {link}, because those are the
 *      only two lib/tracking/message.ts substitutes. Everything else would be
 *      delivered literally.
 *   2. Nothing may promise a capability Instagram does not have: no broadcast,
 *      no reminder past the 24 hour window, no drip, no in-thread checkout.
 *
 * Both rules are enforced by lib/templates/copy-rules.ts and tested over every
 * string in this file.
 *
 * Where a template's DM only makes sense with a destination (a guide, a price
 * list, a calendar), `needsLink` is true. The link is delivered as a tappable
 * button rather than inline text, so a campaign installed before the owner has
 * a URL simply has no button rather than sending a raw "{link}" token to a
 * customer. Those templates install switched off until a link exists.
 *
 * This file holds no marketing prose. The narrative copy for the public pages
 * lives in lib/seo-pages.ts and lib/templates/campaign-templates.ts and stays
 * there; those pages point at a slug in this catalogue rather than restating
 * what a campaign is.
 */

/** What the person is trying to do, which is how the gallery groups cards. */
export type TemplateGroupId = "capture" | "answer" | "inbox";

export interface TemplateGroup {
  id: TemplateGroupId;
  label: string;
  description: string;
}

export const TEMPLATE_GROUPS: readonly TemplateGroup[] = [
  {
    id: "capture",
    label: "Catch the people who put their hand up",
    description:
      "Someone commented because they want something. These send it before the moment passes.",
  },
  {
    id: "answer",
    label: "Answer the question before you see it",
    description:
      "The five questions you type out every week, answered once and sent to everyone who asks.",
  },
  {
    id: "inbox",
    label: "Look after the inbox",
    description:
      "Greetings, thank yous, and business enquiries routed away from the pile.",
  },
] as const;

/**
 * The `Automation` fields a template presets. Every key here is a real column
 * on the model and a real field on the create route's schema, so a template can
 * never set something that does not exist.
 */
export interface TemplatePreset {
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
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
}

export interface CampaignTemplateDefinition {
  slug: string;
  /** The name the campaign is created with, and the card's heading. */
  name: string;
  /** One line. What this does, in the owner's language. */
  description: string;
  /** Who it is for, so a card can be skipped without reading the rest. */
  audience: string;
  group: TemplateGroupId;
  /** Stored on `Automation.goal`, shared vocabulary with the goal cards. */
  goal: string;
  /**
   * True when the DM is only complete once a destination URL exists. Those
   * install switched off, so a half-finished campaign cannot send.
   */
  needsLink: boolean;
  preset: TemplatePreset;
}

type TemplateInput = Omit<CampaignTemplateDefinition, "preset"> & {
  preset: Partial<TemplatePreset> & Pick<TemplatePreset, "dmMessage">;
};

/**
 * Fills in every field a campaign has, so a template only states what it
 * changes and no entry can silently omit a column.
 */
function defineTemplate(input: TemplateInput): CampaignTemplateDefinition {
  return {
    ...input,
    preset: {
      matchAnyPost: true,
      keywords: [],
      matchAnyWord: false,
      wholeWordMatch: true,
      dmTriggerEnabled: false,
      storyReplyEnabled: false,
      storyMentionEnabled: false,
      liveCommentEnabled: false,
      defaultReplyEnabled: false,
      referralRef: null,
      openingDmEnabled: false,
      openingDmMessage: null,
      openingDmButtonLabel: null,
      linkButtonLabel: null,
      requireFollow: false,
      followPromptMessage: null,
      followPromptButtonLabel: null,
      followUpEnabled: false,
      followUpMessage: null,
      followUpDelayMinutes: 0,
      publicReplyEnabled: true,
      publicReplyMessages: [],
      ...input.preset,
    },
  };
}

export const TEMPLATE_CATALOGUE: readonly CampaignTemplateDefinition[] = [
  defineTemplate({
    slug: "lead-magnet",
    name: "Send my free guide",
    description:
      "Someone comments for the freebie and it lands in their DMs seconds later.",
    audience: "Creators and coaches with a guide, checklist or template to give away.",
    group: "capture",
    goal: "Lead magnet delivery",
    needsLink: true,
    preset: {
      keywords: ["GUIDE", "FREE", "SEND", "CHECKLIST"],
      dmMessage:
        "Hey {username}, thanks for asking. The guide is on the button below, it opens straight away and it is yours to keep. Have a read, and if any part of it does not click, reply right here and I will explain it properly.",
      linkButtonLabel: "Get the guide",
      publicReplyMessages: [
        "Sent, have a look in your DMs.",
        "Just sent it over.",
        "On its way to your DMs now.",
      ],
      followUpEnabled: true,
      followUpDelayMinutes: 60,
      followUpMessage:
        "Hey {username}, did the guide open alright? If you got stuck on any part of it, tell me which bit and I will point you at the right page.",
    },
  }),

  defineTemplate({
    slug: "waitlist-signup",
    name: "Build a waitlist",
    description:
      "Collect the people who want in before there is anything to sell them.",
    audience: "Anyone opening a course, a programme or a limited drop.",
    group: "capture",
    goal: "Waitlist signup",
    needsLink: true,
    preset: {
      keywords: ["WAITLIST", "LIST", "EARLY", "FIRST"],
      dmMessage:
        "Hey {username}, the waitlist is open and the button below adds you in one step. Everyone on it gets told first when doors open, and you can take yourself off from that same page whenever you like.",
      linkButtonLabel: "Join the waitlist",
      publicReplyMessages: [
        "Sent you the waitlist link.",
        "It is in your DMs.",
        "Just DMed you where to sign up.",
      ],
    },
  }),

  defineTemplate({
    slug: "giveaway-entry",
    name: "Confirm giveaway entries",
    description:
      "Every entry gets an instant confirmation, so nobody comments three times asking if it counted.",
    audience: "Brands and creators running a prize draw on a post.",
    group: "capture",
    goal: "Giveaway entry",
    needsLink: false,
    preset: {
      keywords: ["ENTER", "ENTERED", "GIVEAWAY", "WIN"],
      dmMessage:
        "Hey {username}, your entry is counted and there is nothing else you need to do. The winner is announced on the giveaway post itself, so keep an eye on the comments there rather than waiting on a message from me. Good luck.",
      publicReplyMessages: [
        "Entered, good luck.",
        "You are in the draw.",
        "Counted, good luck.",
      ],
    },
  }),

  defineTemplate({
    slug: "link-in-bio",
    name: "Send the link they asked for",
    description:
      "Comments like LINK or SHOP get the exact page instead of being told to check the bio.",
    audience: "Shops and creators who post things people want to buy.",
    group: "capture",
    goal: "Product link request",
    needsLink: true,
    preset: {
      keywords: ["LINK", "SHOP", "WHERE"],
      dmMessage:
        "Hey {username}, here it is. The button below goes straight to the page you were asking about, so there is no hunting through my bio. If it is the wrong one, tell me which post you saw and I will send the right link.",
      linkButtonLabel: "Open the link",
      publicReplyMessages: [
        "Sent to your DMs.",
        "Check your DMs, it is there.",
        "Just DMed it to you.",
      ],
    },
  }),

  defineTemplate({
    slug: "product-launch",
    name: "Launch day link drop",
    description:
      "One campaign on the launch post that answers every comment with the page.",
    audience: "Anyone with a launch day and a post that is about to get busy.",
    group: "capture",
    goal: "Launch day request",
    needsLink: true,
    preset: {
      keywords: ["LAUNCH", "DROP", "WANT", "READY"],
      dmMessage:
        "Hey {username}, it is live. The button below goes straight to it, and the page has the price, what is included and the full details in one place. If there is something you want to know before you decide, reply here and I will answer.",
      linkButtonLabel: "See the launch",
      publicReplyMessages: [
        "Sent, it is in your DMs.",
        "Link is in your DMs.",
        "Just sent it across.",
      ],
    },
  }),

  defineTemplate({
    slug: "price-question",
    name: "Answer price questions",
    description:
      "Stop typing the same number under every post. Send the page once and forever.",
    audience: "Service businesses, salons, trades and coaches.",
    group: "answer",
    goal: "Pricing request",
    needsLink: true,
    preset: {
      keywords: ["PRICE", "PRICES", "PRICING", "COST", "RATES"],
      // People ask this in the comments and in the inbox, so both doors are
      // open on the same campaign.
      dmTriggerEnabled: true,
      dmMessage:
        "Hey {username}, good question. The full price list is on the button below with what is included in each option, so you can see where you land before we even talk. If something on it needs explaining, reply here and I will go through it.",
      linkButtonLabel: "See pricing",
      publicReplyMessages: [
        "Sent you the price list.",
        "Prices are in your DMs.",
        "Just sent it across.",
      ],
    },
  }),

  defineTemplate({
    slug: "booking-request",
    name: "Get appointments booked",
    description:
      "Turns a comment into a slot on the calendar without a back and forth.",
    audience: "Anyone whose calendar is the product: clinics, salons, consultants.",
    group: "answer",
    goal: "Booking request",
    needsLink: true,
    preset: {
      keywords: ["BOOK", "BOOKING", "APPOINTMENT", "SLOT", "AVAILABILITY"],
      dmTriggerEnabled: true,
      dmMessage:
        "Hey {username}, the calendar is on the button below and it shows every free slot as it really is, so whatever you pick is genuinely open. It takes about a minute and you get a confirmation straight away.",
      linkButtonLabel: "Book a time",
      publicReplyMessages: [
        "Sent you the booking link.",
        "Booking link is in your DMs.",
        "Check your DMs for the calendar.",
      ],
      followUpEnabled: true,
      followUpDelayMinutes: 120,
      followUpMessage:
        "Hey {username}, did you find a time that works? If nothing on there suits you, reply with the days you are usually free and I will see what else I can open up.",
    },
  }),

  defineTemplate({
    slug: "faq-deflection",
    name: "Answer the same question",
    description:
      "The question you get twenty times a week, answered once and sent to everyone who asks it.",
    audience: "Any account whose inbox is the same five questions on repeat.",
    group: "answer",
    goal: "Common question",
    needsLink: true,
    preset: {
      // The catch-all: it answers inbound DMs that no keyword campaign wanted,
      // so it matches any word and carries no post trigger at all.
      matchAnyPost: false,
      matchAnyWord: true,
      dmTriggerEnabled: true,
      defaultReplyEnabled: true,
      dmMessage:
        "Hey {username}, thanks for the message. The button below answers the questions I get asked most, so there is a good chance yours is in there. If it is not, reply and tell me what you are trying to work out and a person will pick this up.",
      linkButtonLabel: "Read the answers",
      // There is no comment behind a default reply, so there is nothing to
      // reply to in public.
      publicReplyEnabled: false,
    },
  }),

  defineTemplate({
    slug: "restock-alert",
    name: "Handle restock questions",
    description:
      "Sold-out comments get the restock page instead of a promise you have to remember.",
    audience: "Shops that sell out and get asked when it is coming back.",
    group: "answer",
    goal: "Restock request",
    needsLink: true,
    preset: {
      keywords: ["RESTOCK", "STOCK", "BACK", "SOLD"],
      dmMessage:
        "Hey {username}, it is not in stock right now. The button below is the restock page: leave your email there and the shop emails you the moment it lands, which is far more reliable than either of us remembering this chat.",
      linkButtonLabel: "Get restock news",
      publicReplyMessages: [
        "Sent you the restock page.",
        "Restock link is in your DMs.",
        "DMed you where to sign up.",
      ],
    },
  }),

  defineTemplate({
    slug: "vip-routing",
    name: "Route collabs and press",
    description:
      "Brand, press and wholesale enquiries get the right form instead of sitting in the pile.",
    audience: "Creators and brands whose business enquiries arrive mixed in with fan mail.",
    group: "inbox",
    goal: "Partnership enquiry",
    needsLink: true,
    preset: {
      keywords: ["COLLAB", "PARTNERSHIP", "PRESS", "WHOLESALE", "SPONSOR"],
      dmTriggerEnabled: true,
      dmMessage:
        "Hey {username}, thanks for reaching out. The button below is the partnership form. It takes two minutes and it goes to the person who actually handles this rather than into the general inbox, so you will hear back properly.",
      linkButtonLabel: "Partnership form",
      publicReplyMessages: [
        "Sent you the form.",
        "Details are in your DMs.",
        "Check your DMs, the form is there.",
      ],
    },
  }),

  defineTemplate({
    slug: "new-follower-welcome",
    // Named for the door it actually sits behind. It used to be called
    // "New follower welcome", which promised a follow trigger Instagram does
    // not expose, so it read as broken to anyone who opened it.
    name: "Welcome people who open a chat from your link",
    description:
      "The first thing someone sees when they open a chat with you from your profile link, QR code or ice breaker.",
    audience: "Accounts sending people to their profile from a bio link, a card or an ad.",
    group: "inbox",
    goal: "Welcome message",
    needsLink: false,
    preset: {
      // Instagram has no follow event to hook. What it does have is a referral
      // entry: a link, QR code or website button carrying a ref. That is the
      // moment a new follower actually reaches the inbox, so that is the door
      // this campaign sits behind.
      matchAnyPost: false,
      matchAnyWord: true,
      referralRef: "welcome",
      openingDmEnabled: true,
      openingDmMessage:
        "Hey {username}, welcome in, I am glad you found me. Tap below and I will tell you the quickest way to get something useful out of this account.",
      openingDmButtonLabel: "Show me where to start",
      dmMessage:
        "Hey {username}, welcome. Most people here are after one of three things: what I do, what it costs, or how to work with me. Reply with whichever one you want and I will send it straight over.",
      publicReplyEnabled: false,
    },
  }),

  defineTemplate({
    slug: "story-reply-thanks",
    name: "Thank story repliers",
    description:
      "Everyone who replies to a story gets a real answer instead of a heart and silence.",
    audience: "Accounts that post stories and cannot keep up with the replies.",
    group: "inbox",
    goal: "Thank you reply",
    needsLink: false,
    preset: {
      matchAnyPost: false,
      matchAnyWord: true,
      storyReplyEnabled: true,
      dmMessage:
        "Hey {username}, thank you for replying, it genuinely helps me know what to post more of. If you were asking me something rather than just saying hi, say it again here and I will give you a proper answer.",
      publicReplyEnabled: false,
    },
  }),
] as const;

const TEMPLATES_BY_SLUG = new Map<string, CampaignTemplateDefinition>(
  TEMPLATE_CATALOGUE.map((template) => [template.slug, template])
);

export function getTemplate(
  slug: string | null | undefined
): CampaignTemplateDefinition | null {
  if (!slug) return null;
  return TEMPLATES_BY_SLUG.get(slug) ?? null;
}

export function getTemplateSlugs(): string[] {
  return TEMPLATE_CATALOGUE.map((template) => template.slug);
}

export interface TemplateGroupSection {
  group: TemplateGroup;
  templates: CampaignTemplateDefinition[];
}

/** The catalogue in gallery order: grouped by what the person wants to do. */
export function getTemplatesByGroup(): TemplateGroupSection[] {
  return TEMPLATE_GROUPS.map((group) => ({
    group,
    templates: TEMPLATE_CATALOGUE.filter(
      (template) => template.group === group.id
    ),
  }));
}

/**
 * Every audience-facing string a template carries. The copy rules are checked
 * over exactly this list, so adding a new message field to a preset without
 * adding it here is the one way a rule could be dodged.
 */
export function templateCopyStrings(
  template: CampaignTemplateDefinition
): string[] {
  const { preset } = template;

  return [
    preset.dmMessage,
    preset.openingDmMessage,
    preset.followUpMessage,
    preset.followPromptMessage,
    ...preset.publicReplyMessages,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}
