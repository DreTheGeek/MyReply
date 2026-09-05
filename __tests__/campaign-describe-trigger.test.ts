import { describe, expect, it } from "vitest";

import {
  SURFACES,
  describeTrigger,
  summarizeTrigger,
  type TriggerShape,
} from "../lib/campaigns/describe-trigger";

function campaign(overrides: Partial<TriggerShape> = {}): TriggerShape {
  return {
    matchAnyPost: false,
    pendingNextReel: false,
    postId: null,
    keywords: [],
    matchAnyWord: false,
    dmTriggerEnabled: false,
    storyReplyEnabled: false,
    storyMentionEnabled: false,
    liveCommentEnabled: false,
    defaultReplyEnabled: false,
    referralRef: null,
    ...overrides,
  };
}

describe("describeTrigger", () => {
  it("does not describe a referral campaign as a comment on a post", () => {
    // The bug this file exists for. A campaign installed from the welcome
    // template fires on a referral ref, has no post, and used to render as
    // "When someone comments on: a specific post or reel" pointing at nothing.
    const welcome = campaign({ referralRef: "welcome", matchAnyWord: true });
    const described = describeTrigger(welcome);

    expect(described.surface).toBe("link");
    expect(described.heading).not.toContain("comments");
    expect(described.showsPost).toBe(false);
    expect(described.warning).toBeNull();
    expect(summarizeTrigger(welcome)).toBe(
      'Chats opened from a link tagged "welcome"'
    );
  });

  it("warns when a comment campaign watches a specific post it never got", () => {
    const orphan = campaign({ keywords: ["PRICE"] });
    const described = describeTrigger(orphan);

    expect(described.surface).toBe("comments");
    expect(described.what).toBe("No post chosen yet");
    expect(described.warning).toContain("no post has been chosen");
  });

  it("leaves a properly targeted comment campaign unwarned", () => {
    expect(describeTrigger(campaign({ matchAnyPost: true })).warning).toBeNull();
    expect(
      describeTrigger(campaign({ pendingNextReel: true })).warning
    ).toBeNull();
    expect(describeTrigger(campaign({ postId: "17900" })).warning).toBeNull();
  });

  it("puts every trigger on exactly one of the listed surfaces", () => {
    const cases: TriggerShape[] = [
      campaign({ matchAnyPost: true }),
      campaign({ dmTriggerEnabled: true }),
      campaign({ storyReplyEnabled: true }),
      campaign({ storyMentionEnabled: true }),
      campaign({ liveCommentEnabled: true }),
      campaign({ referralRef: "welcome" }),
      campaign({ defaultReplyEnabled: true }),
    ];

    const ids = new Set(SURFACES.map((s) => s.id));
    for (const shape of cases) {
      expect(ids.has(describeTrigger(shape).surface)).toBe(true);
    }
  });
});

describe("summarizeTrigger", () => {
  it("reads as a sentence rather than a field dump", () => {
    expect(
      summarizeTrigger(
        campaign({ matchAnyPost: true, keywords: ["PRICE", "COST"] })
      )
    ).toBe("Comments saying PRICE or COST, on any post or reel");

    expect(
      summarizeTrigger(campaign({ matchAnyPost: true, matchAnyWord: true }))
    ).toBe("Comments, on any post or reel");

    expect(
      summarizeTrigger(campaign({ pendingNextReel: true, keywords: ["LINK"] }))
    ).toBe("Comments saying LINK, on your next reel");
  });

  it("joins three or more keywords without trailing commas", () => {
    expect(
      summarizeTrigger(
        campaign({ matchAnyPost: true, keywords: ["A", "B", "C"] })
      )
    ).toContain("saying A, B or C");
  });

  it("describes the non-comment surfaces without mentioning posts", () => {
    expect(summarizeTrigger(campaign({ dmTriggerEnabled: true }))).toBe(
      "Direct messages"
    );
    expect(summarizeTrigger(campaign({ storyMentionEnabled: true }))).toBe(
      "Stories that mention you"
    );
    expect(summarizeTrigger(campaign({ storyReplyEnabled: true }))).toBe(
      "Story replies"
    );
    expect(summarizeTrigger(campaign({ defaultReplyEnabled: true }))).toBe(
      "Any message no other campaign answered"
    );
    expect(
      summarizeTrigger(campaign({ liveCommentEnabled: true, keywords: ["WIN"] }))
    ).toBe("Live comments saying WIN");
  });
});
