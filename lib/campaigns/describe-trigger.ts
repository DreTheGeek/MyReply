/**
 * What actually sets a campaign off, in words.
 *
 * A campaign can fire on any of several inbound surfaces, and the detail page
 * used to describe all of them as a comment on a post. A referral campaign with
 * no post attached read as "When someone comments on: a specific post or reel"
 * while pointing at nothing, which is wrong and gives the reader no way to work
 * out what is really wired up.
 *
 * `heading` and `what` are the two halves of the sentence on the page.
 * `anyLabel` is what "match anything" means for that surface: on a comment it
 * is any comment, on a DM it is any message.
 * `warning` is set when the campaign, as configured, cannot fire at all.
 */

/**
 * The inbound surfaces Instagram gives us. A campaign listens on exactly one,
 * which is what makes this the right axis to group a campaign list by: the
 * groups are mutually exclusive and every campaign lands in one of them.
 */
export type SurfaceId =
  "comments" | "dm" | "story" | "live" | "link" | "fallback";

export interface Surface {
  id: SurfaceId;
  label: string;
  /** One sentence, shown under the group heading. */
  blurb: string;
}

/** Ordered as a person would look for them, commonest first. */
export const SURFACES: readonly Surface[] = [
  {
    id: "comments",
    label: "Comments",
    blurb: "Someone comments on a post or a reel.",
  },
  {
    id: "dm",
    label: "Direct messages",
    blurb: "Someone sends a message to your inbox.",
  },
  {
    id: "story",
    label: "Stories",
    blurb: "Someone replies to your story or tags you in theirs.",
  },
  {
    id: "live",
    label: "Live videos",
    blurb: "Someone comments while you are broadcasting.",
  },
  {
    id: "link",
    label: "Links and QR codes",
    blurb: "Someone opens a chat from a link, a QR code or your profile.",
  },
  {
    id: "fallback",
    label: "Catch all",
    blurb: "Answers anything no other campaign picked up.",
  },
] as const;

export interface TriggerDescription {
  /** Which inbound surface this campaign listens on, used to group a list. */
  surface: SurfaceId;
  heading: string;
  what: string;
  anyLabel: string;
  /** Present only when nothing can set this campaign off. */
  warning: string | null;
  /** True when the post thumbnail is meaningful for this trigger. */
  showsPost: boolean;
}

export interface TriggerShape {
  matchAnyPost: boolean;
  pendingNextReel: boolean;
  postId: string | null;
  keywords: string[];
  matchAnyWord: boolean;
  dmTriggerEnabled: boolean;
  storyReplyEnabled: boolean;
  storyMentionEnabled: boolean;
  liveCommentEnabled: boolean;
  defaultReplyEnabled: boolean;
  referralRef: string | null;
}

export function describeTrigger(campaign: TriggerShape): TriggerDescription {
  if (campaign.referralRef) {
    return {
      surface: "link",
      heading: "When someone opens a chat from your link",
      // Instagram has no follow event available to this app, so there is no
      // way to greet a new follower the moment they follow. This is the
      // nearest real thing: a person arriving through a link that carries a
      // ref, which is what an ig.me link, a QR code or a profile button does.
      what: `An ig.me link or QR code carrying the ref "${campaign.referralRef}"`,
      anyLabel: "Anything they say",
      warning: null,
      showsPost: false,
    };
  }

  if (campaign.defaultReplyEnabled) {
    return {
      surface: "fallback",
      heading: "When a message matches nothing else",
      what: "Any DM no other campaign answered",
      anyLabel: "Anything they say",
      warning: null,
      showsPost: false,
    };
  }

  if (campaign.storyMentionEnabled) {
    return {
      surface: "story",
      heading: "When someone mentions you in their story",
      what: "Any story that tags this account",
      anyLabel: "Any mention",
      warning: null,
      showsPost: false,
    };
  }

  if (campaign.storyReplyEnabled) {
    return {
      surface: "story",
      heading: "When someone replies to your story",
      what: "Any story reply",
      anyLabel: "Any reply",
      warning: null,
      showsPost: false,
    };
  }

  if (campaign.liveCommentEnabled) {
    return {
      surface: "live",
      heading: "When someone comments during a Live",
      what: "Comments on your Live broadcast",
      anyLabel: "Any comment",
      // Instagram only accepts a reply while the broadcast is running, so a
      // rate-limited one cannot be retried later.
      warning: null,
      showsPost: false,
    };
  }

  if (campaign.dmTriggerEnabled && !campaign.postId && !campaign.matchAnyPost) {
    return {
      surface: "dm",
      heading: "When someone sends you a DM",
      what: "Any direct message",
      anyLabel: "Any message",
      warning: null,
      showsPost: false,
    };
  }

  const what = campaign.matchAnyPost
    ? "Any post or reel"
    : campaign.pendingNextReel
      ? "Your next reel"
      : campaign.postId
        ? "A specific post or reel"
        : "No post chosen yet";

  return {
    surface: "comments",
    heading: "When someone comments on",
    what,
    anyLabel: "Any comment",
    // The case that shipped: a comment campaign set to one specific post, with
    // no post ever attached. It reports itself as live and can never fire.
    warning:
      !campaign.matchAnyPost && !campaign.pendingNextReel && !campaign.postId
        ? "This campaign is set to watch one specific post, but no post has been chosen, so nothing can set it off. Pick a post, or switch it to every post."
        : null,
    showsPost: true,
  };
}

/**
 * The whole trigger as one sentence, for a list row where a two-part heading
 * plus a thumbnail plus a chip row is more furniture than information.
 *
 * It reads as English rather than as fields: "Comments saying PRICE or COST,
 * on any post or reel" instead of "Any post or reel / PRICE, COST".
 */
export function summarizeTrigger(campaign: TriggerShape): string {
  const trigger = describeTrigger(campaign);
  const match = describeMatch(campaign, trigger.surface);

  switch (trigger.surface) {
    case "link":
      return campaign.referralRef
        ? `Chats opened from a link tagged "${campaign.referralRef}"`
        : "Chats opened from a link or QR code";
    case "fallback":
      return "Any message no other campaign answered";
    case "story":
      return campaign.storyMentionEnabled
        ? "Stories that mention you"
        : `Story replies${match}`;
    case "live":
      return `Live comments${match}`;
    case "dm":
      return `Direct messages${match}`;
    case "comments":
      return `Comments${match}, on ${lowerFirst(trigger.what)}`;
  }
}

/** ", saying PRICE or COST" when there are keywords, otherwise nothing. */
function describeMatch(campaign: TriggerShape, surface: SurfaceId): string {
  if (surface === "link" || surface === "fallback") return "";
  if (campaign.matchAnyWord || campaign.keywords.length === 0) return "";
  return ` saying ${listWords(campaign.keywords)}`;
}

/** "PRICE", "PRICE or COST", "PRICE, COST or HOW MUCH". */
function listWords(words: string[]): string {
  if (words.length === 1) return words[0];
  const head = words.slice(0, -1).join(", ");
  return `${head} or ${words[words.length - 1]}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
