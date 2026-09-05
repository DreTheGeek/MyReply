import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetUserMedia } = vi.hoisted(() => ({
  mockGetUserMedia: vi.fn(),
}));

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...actual, getUserMedia: mockGetUserMedia };
});

import type { InstagramMedia } from "../lib/meta/client";
import { GOAL_CARDS, MAX_FOLLOW_UP_DELAY_MINUTES } from "../lib/suggestions";
import { captionUrl, inferGoal } from "../lib/onboarding/goal-inference";
import {
  DRAFT_COUNT,
  POSTS_TO_READ,
  stripLinkToken,
  suggestOnboardingDrafts,
} from "../lib/onboarding/suggest";

const ACCOUNT = { id: "acct_1", username: "lasean" };

function media(
  overrides: Partial<InstagramMedia> & { id: string }
): InstagramMedia {
  return {
    media_type: "IMAGE",
    timestamp: "2026-03-01T12:00:00+0000",
    permalink: `https://www.instagram.com/p/${overrides.id}/`,
    ...overrides,
  };
}

function suggest(posts: InstagramMedia[]) {
  mockGetUserMedia.mockResolvedValue(posts);
  return suggestOnboardingDrafts({ accessToken: "token", account: ACCOUNT });
}

/** A grid whose captions each point somewhere different. */
const RICH_GRID: InstagramMedia[] = [
  media({
    id: "p1",
    caption:
      "New pricing is live. Packages start at $499. Comment PRICE and I will send the full breakdown.",
    comments_count: 42,
    like_count: 300,
    media_product_type: "REELS",
    media_type: "VIDEO",
    thumbnail_url: "https://cdn.example.com/p1.jpg",
  }),
  media({
    id: "p2",
    caption:
      "Free guide to your first 1000 followers. Download it here https://example.com/guide",
    comments_count: 11,
  }),
  media({
    id: "p3",
    caption:
      "Two coaching slots open this month. Book a call: https://calendly.com/lasean/intro",
  }),
  media({
    id: "p4",
    caption: "Doors open Monday. Join the waitlist for early access.",
  }),
  media({
    id: "p5",
    caption: "Use code SPRING for 20% off everything this weekend only.",
  }),
  media({
    id: "p6",
    caption: "Step by step tutorial on the full morning routine.",
  }),
];

describe("the suggestion engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds five drafts for an account with posts", async () => {
    const result = await suggest(RICH_GRID);

    expect(result.drafts).toHaveLength(DRAFT_COUNT);
    expect(result.postsRead).toBe(RICH_GRID.length);
    expect(result.usedFallback).toBe(false);
    expect(result.account).toEqual(ACCOUNT);
  });

  it("still builds five drafts for a brand new account with no posts", async () => {
    const result = await suggest([]);

    expect(result.drafts).toHaveLength(DRAFT_COUNT);
    expect(result.postsRead).toBe(0);
    expect(result.usedFallback).toBe(true);
    // Nothing to point at, so every draft listens to every post.
    for (const draft of result.drafts) {
      expect(draft.post).toBeNull();
      expect(draft.automation.matchAnyPost).toBe(true);
      expect(draft.automation.postId).toBeNull();
    }
  });

  it("still builds five drafts when Instagram cannot be reached", async () => {
    mockGetUserMedia.mockRejectedValue(new Error("token expired"));

    const result = await suggestOnboardingDrafts({
      accessToken: "token",
      account: ACCOUNT,
    });

    expect(result.drafts).toHaveLength(DRAFT_COUNT);
    expect(result.usedFallback).toBe(true);
  });

  it("gives an account with a single post five drafts, not one", async () => {
    const result = await suggest([media({ id: "only", caption: "Sunday." })]);

    expect(result.drafts).toHaveLength(DRAFT_COUNT);
    // One card can point at the post; the rest listen to everything.
    expect(result.drafts.filter((draft) => draft.post !== null)).toHaveLength(1);
  });

  it("reads only a single page of recent posts", async () => {
    await suggest(RICH_GRID);
    expect(mockGetUserMedia).toHaveBeenCalledWith("token", POSTS_TO_READ);
  });

  it("makes the five drafts different from one another", async () => {
    const result = await suggest(RICH_GRID);

    const goals = result.drafts.map((draft) => draft.goal);
    expect(new Set(goals).size).toBe(DRAFT_COUNT);

    const posts = result.drafts.map((draft) => draft.post?.id);
    expect(new Set(posts).size).toBe(DRAFT_COUNT);

    const messages = result.drafts.map((draft) => draft.dmMessage);
    expect(new Set(messages).size).toBe(DRAFT_COUNT);

    const summaries = result.drafts.map((draft) => draft.summary);
    expect(new Set(summaries).size).toBe(DRAFT_COUNT);
  });

  it("draws the keyword from the caption when the caption names one", async () => {
    const result = await suggest(RICH_GRID);

    const pricing = result.drafts.find(
      (draft) => draft.goal === "price_question"
    );
    expect(pricing?.keyword).toBe("PRICE");
    expect(pricing?.automation.keywords[0]).toBe("PRICE");
  });

  it("reads a discount code as a thing to deliver, keyword and all", async () => {
    const result = await suggest([
      media({ id: "sale", caption: "Use code SPRING for 20% off this weekend." }),
    ]);

    const draft = result.drafts.find((item) => item.post?.id === "sale");
    expect(draft?.goal).toBe("lead_magnet");
    expect(draft?.automation.keywords).toContain("SPRING");
  });

  it("never leaves a draft with nothing to trigger on", async () => {
    const result = await suggest([media({ id: "bare", caption: "" })]);

    for (const draft of result.drafts) {
      // The create route demands one or the other, never neither.
      expect(
        draft.automation.matchAnyWord || draft.automation.keywords.length > 0
      ).toBe(true);
      // A card that shows a keyword must have one to show.
      if (!draft.automation.matchAnyWord) {
        expect(draft.keyword).toBeTruthy();
        expect(draft.keyword).toBe(draft.automation.keywords[0]);
      } else {
        expect(draft.keyword).toBeNull();
      }
    }
  });

  it("hands every draft a complete, written message and public replies", async () => {
    const result = await suggest(RICH_GRID);

    for (const draft of result.drafts) {
      expect(draft.dmMessage.trim().length).toBeGreaterThan(20);
      expect(draft.dmMessage).toContain("{username}");
      expect(draft.publicReplyMessages.length).toBeGreaterThan(1);
      expect(draft.automation.publicReplyEnabled).toBe(true);
      expect(draft.automation.name.trim()).toBeTruthy();
      expect(draft.automation.goal.trim()).toBeTruthy();
      // No template placeholder ever reaches the screen.
      expect(draft.summary).not.toMatch(/\{\w+\}/);
      expect(draft.postContext ?? "").not.toMatch(/\{\w+\}/);
    }
  });

  it("pauses a draft whose message points at a link it does not have", async () => {
    // Deleting the token instead leaves the words that pointed at it, so the
    // DM reads "Full pricing is on this page" with no page. A paused campaign
    // asking for one URL beats a live campaign sending a dangling sentence.
    const result = await suggest(RICH_GRID);

    for (const draft of result.drafts) {
      if (draft.automation.trackedDestinationUrl !== null) continue;

      if (draft.dmMessage.includes("{link}")) {
        expect(draft.needsLink).toBe(true);
        expect(draft.automation.isActive).toBe(false);
      } else {
        expect(draft.needsLink).toBe(false);
      }

      // Either way, never a button offering a link that does not exist.
      expect(draft.automation.linkButtonLabel).toBeNull();
    }
  });

  it("never marks a draft as needing a link when it already has one", async () => {
    const result = await suggest(RICH_GRID);

    for (const draft of result.drafts) {
      if (draft.automation.trackedDestinationUrl !== null) {
        expect(draft.needsLink).toBe(false);
      }
    }
  });

  it("leaves a message readable after the link token is removed", () => {
    expect(
      stripLinkToken(
        "Hey {username}, here is the guide I promised: {link}. Have a read."
      )
    ).toBe("Hey {username}, here is the guide I promised. Have a read.");

    expect(stripLinkToken("{username}, here it is: {link}")).toBe(
      "{username}, here it is."
    );

    expect(stripLinkToken("Sent. {link} Grab it while you can.")).toBe(
      "Sent. Grab it while you can."
    );

    // Nothing to do is not a reason to mangle anything.
    expect(stripLinkToken("Thank you, genuinely.")).toBe(
      "Thank you, genuinely."
    );
  });

  it("takes the tracked link from the caption's own URL", async () => {
    const result = await suggest(RICH_GRID);

    const leadMagnet = result.drafts.find(
      (draft) => draft.goal === "lead_magnet"
    );
    expect(leadMagnet?.automation.trackedDestinationUrl).toBe(
      "https://example.com/guide"
    );

    const booking = result.drafts.find((draft) => draft.goal === "booking");
    expect(booking?.automation.trackedDestinationUrl).toBe(
      "https://calendly.com/lasean/intro"
    );
  });

  it("keeps every follow-up delay inside Instagram's messaging window", async () => {
    const result = await suggest(RICH_GRID);

    for (const draft of result.drafts) {
      expect(draft.automation.followUpDelayMinutes).toBeGreaterThanOrEqual(0);
      expect(draft.automation.followUpDelayMinutes).toBeLessThanOrEqual(
        MAX_FOLLOW_UP_DELAY_MINUTES
      );
    }
  });

  it("never names an Instagram account on a draft", async () => {
    const result = await suggest(RICH_GRID);
    for (const draft of result.drafts) {
      expect(draft.automation.instagramAccountId).toBeNull();
    }
  });

  it("returns stable draft ids across repeated runs", async () => {
    const first = await suggest(RICH_GRID);
    const second = await suggest(RICH_GRID);
    expect(first.drafts.map((d) => d.id)).toEqual(
      second.drafts.map((d) => d.id)
    );
  });

  it("writes every DM in the tone it was asked for", async () => {
    mockGetUserMedia.mockResolvedValue(RICH_GRID);

    const friendly = await suggestOnboardingDrafts({
      accessToken: "token",
      account: ACCOUNT,
      tone: "friendly",
    });
    const professional = await suggestOnboardingDrafts({
      accessToken: "token",
      account: ACCOUNT,
      tone: "professional",
    });

    expect(friendly.drafts.map((d) => d.dmMessage)).not.toEqual(
      professional.drafts.map((d) => d.dmMessage)
    );
    // Same campaigns, different voice.
    expect(friendly.drafts.map((d) => d.id)).toEqual(
      professional.drafts.map((d) => d.id)
    );
  });
});

describe("drafts never claim engagement data that was not measured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The rule this guards: a card may describe a post, and may state a comment
   * count Instagram actually returned, but may never characterise what the
   * comments contain or how the post performed.
   */
  const FORBIDDEN =
    /\b(?:gets? a lot of|lots of|plenty of|loads of|your best|top[- ]performing|most engaged|viral|popular|people (?:always|often|keep) ask|everyone asks|high[- ]performing|blew up)\b/i;

  it("says nothing about performance on any draft", async () => {
    const result = await suggest(RICH_GRID);

    for (const draft of result.drafts) {
      for (const text of [
        draft.title,
        draft.summary,
        draft.postContext ?? "",
      ]) {
        expect(text).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("omits a comment count Instagram did not return, rather than inventing one", async () => {
    const result = await suggest([
      media({ id: "nocount", caption: "Comment GUIDE for the free template." }),
    ]);

    const draft = result.drafts.find((item) => item.post?.id === "nocount");
    expect(draft?.post?.commentsCount).toBeNull();
    expect(draft?.postContext).not.toMatch(/\d+\s+comments?/i);
  });

  it("states a comment count only when Instagram returned one", async () => {
    const result = await suggest(RICH_GRID);
    const pricing = result.drafts.find(
      (draft) => draft.goal === "price_question"
    );

    expect(pricing?.post?.commentsCount).toBe(42);
    expect(pricing?.postContext).toContain("42 comments");
  });

  it("reports a zero count as measured rather than as absent", async () => {
    const result = await suggest([
      media({
        id: "zero",
        caption: "Comment GUIDE for the free template.",
        comments_count: 0,
      }),
    ]);

    const draft = result.drafts.find((item) => item.post?.id === "zero");
    expect(draft?.post?.commentsCount).toBe(0);
    // Measured, but there is nothing worth saying about zero, so it is not said.
    expect(draft?.postContext).not.toMatch(/0 comments/);
  });

  it("describes the post from its caption, not from its numbers", async () => {
    const result = await suggest(RICH_GRID);
    const booking = result.drafts.find((draft) => draft.goal === "booking");

    expect(booking?.postContext).toContain("Your post from");
    expect(booking?.postContext).toContain("a booking link");
  });
});

describe("inferring a goal from a caption", () => {
  it("reads a booking host as the strongest possible booking signal", () => {
    expect(inferGoal("Grab a slot https://calendly.com/me/intro")?.goal).toBe(
      "booking"
    );
  });

  it("reads a price in the caption as a pricing question", () => {
    expect(inferGoal("Packages from $499 this month")?.goal).toBe(
      "price_question"
    );
  });

  it("reads a free resource as a lead magnet", () => {
    expect(inferGoal("Grab my free checklist below")?.goal).toBe("lead_magnet");
  });

  it("reads a discount as something to deliver", () => {
    expect(inferGoal("Use code SPRING for 20% off")?.goal).toBe("lead_magnet");
  });

  it("reads a launch as a waitlist", () => {
    expect(inferGoal("Doors open Monday, join the waitlist")?.goal).toBe(
      "waitlist"
    );
  });

  it("reads a walkthrough as a question answered in advance", () => {
    expect(inferGoal("Step by step tutorial on the morning routine")?.goal).toBe(
      "faq"
    );
  });

  it("returns nothing at all when the caption signals nothing", () => {
    expect(inferGoal("Sunday.")).toBeNull();
    expect(inferGoal("")).toBeNull();
    expect(inferGoal(null)).toBeNull();
  });

  it("treats a bare link as weak intent rather than as nothing", () => {
    const inference = inferGoal("https://example.com/thing");
    expect(inference?.goal).toBe("lead_magnet");
    expect(inference?.confidence).toBeGreaterThan(0);
    expect(inference?.confidence).toBeLessThan(0.5);
  });

  it("only ever names a goal the suggestion library knows about", () => {
    const known = new Set(GOAL_CARDS.map((card) => card.id));
    const captions = [
      "Grab a slot https://calendly.com/me/intro",
      "Packages from $499",
      "Free checklist below",
      "Use code SPRING for 20% off",
      "Join the waitlist",
      "Step by step tutorial",
      "Open to collab and brand deals, media kit below",
    ];

    for (const caption of captions) {
      const inference = inferGoal(caption);
      expect(inference).not.toBeNull();
      expect(known.has(inference!.goal)).toBe(true);
    }
  });

  it("pulls a usable URL out of a caption and ignores an unusable one", () => {
    expect(captionUrl("see https://example.com/a.")).toBe(
      "https://example.com/a"
    );
    expect(captionUrl("no link here")).toBeNull();
    expect(captionUrl(null)).toBeNull();
  });
});

describe("the goal catalogue this screen draws on", () => {
  it("has at least as many goals as there are cards, so five can differ", () => {
    expect(GOAL_CARDS.length).toBeGreaterThanOrEqual(DRAFT_COUNT);
  });
});
