import { describe, expect, it } from "vitest";

import {
  BUSINESS_HOURS_PRESETS,
  CONDITION_PRESETS,
  DEFAULT_TONE,
  DM_MESSAGES,
  FOLLOW_UP_TIMING_PRESETS,
  GOAL_CARDS,
  GOAL_IDS,
  GOAL_KEYWORDS,
  KEYWORD_BLOCKLIST,
  MAX_FOLLOW_UP_DELAY_MINUTES,
  MAX_KEYWORD_SUGGESTIONS,
  MIN_KEYWORD_SUGGESTIONS,
  PUBLIC_REPLY_MESSAGES,
  TONE_IDS,
  TONE_OPTIONS,
  WORKSPACE_TONE_VALUES,
  buildAutomationDraft,
  clampFollowUpDelayMinutes,
  findUnknownPlaceholders,
  getBusinessHoursPreset,
  getConditionPreset,
  getFollowUpTimingPreset,
  getGoalCard,
  getToneOption,
  getWorkspaceTone,
  isBlockedKeyword,
  isGoal,
  isTone,
  isWithinBusinessHours,
  resolveTone,
  suggestKeywords,
  suggestMessage,
  suggestMessages,
  suggestPublicReplies,
  toneToWorkspaceTone,
} from "@/lib/suggestions";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { renderMessageWithTracking } from "@/lib/tracking/message";

describe("suggestions: the message library", () => {
  it("has at least three complete messages for every goal and tone pair", () => {
    for (const goal of GOAL_IDS) {
      for (const tone of TONE_IDS) {
        const messages = suggestMessages(goal, tone);
        expect(
          messages.length,
          `${goal} / ${tone} has ${messages.length} messages`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("never uses a placeholder the sender would not substitute", () => {
    for (const goal of GOAL_IDS) {
      for (const tone of TONE_IDS) {
        for (const message of suggestMessages(goal, tone)) {
          expect(
            findUnknownPlaceholders(message),
            `${goal} / ${tone}: ${message}`
          ).toEqual([]);
        }
      }
    }
  });

  it("never uses an unknown placeholder in a public reply", () => {
    for (const goal of GOAL_IDS) {
      for (const reply of suggestPublicReplies(goal)) {
        expect(findUnknownPlaceholders(reply), reply).toEqual([]);
      }
    }
  });

  it("writes messages a person could send without editing", () => {
    for (const goal of GOAL_IDS) {
      for (const tone of TONE_IDS) {
        for (const message of suggestMessages(goal, tone)) {
          expect(message.trim()).toBe(message);
          expect(message.length).toBeGreaterThan(10);
          // The create route caps dmMessage at 1000 characters.
          expect(message.length).toBeLessThanOrEqual(1000);
          // Not sample data.
          expect(message.toLowerCase()).not.toContain("lorem");
          expect(message).not.toContain("TODO");
        }
      }
    }
  });

  it("keeps a lid on exclamation marks, hype included", () => {
    for (const goal of GOAL_IDS) {
      for (const tone of TONE_IDS) {
        for (const message of suggestMessages(goal, tone)) {
          const shouts = (message.match(/!/g) ?? []).length;
          expect(shouts, `${goal} / ${tone}: ${message}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("contains no em dashes anywhere in the copy", () => {
    // Built from the code point rather than typed, so this file stays clean of
    // the character it is policing.
    const emDash = String.fromCharCode(0x2014);
    for (const goal of GOAL_IDS) {
      for (const tone of TONE_IDS) {
        for (const message of suggestMessages(goal, tone)) {
          expect(message).not.toContain(emDash);
        }
      }
      for (const reply of suggestPublicReplies(goal)) {
        expect(reply).not.toContain(emDash);
      }
    }
  });

  it("varies sentence length inside a goal and tone pair", () => {
    for (const goal of GOAL_IDS) {
      for (const tone of TONE_IDS) {
        const lengths = suggestMessages(goal, tone).map((m) => m.length);
        const unique = new Set(lengths);
        expect(unique.size, `${goal} / ${tone}`).toBeGreaterThan(1);
      }
    }
  });

  it("gives every message pair distinct options", () => {
    for (const goal of GOAL_IDS) {
      for (const tone of TONE_IDS) {
        const messages = suggestMessages(goal, tone);
        expect(new Set(messages).size).toBe(messages.length);
      }
    }
  });

  it("offers at least five distinct public replies per goal so a thread does not read as a bot", () => {
    for (const goal of GOAL_IDS) {
      const replies = suggestPublicReplies(goal);
      expect(replies.length, goal).toBeGreaterThanOrEqual(5);
      expect(new Set(replies).size).toBe(replies.length);
      for (const reply of replies) {
        // The create route caps each variation at 1000 characters and the
        // array at 10 entries.
        expect(reply.length).toBeLessThanOrEqual(1000);
      }
      expect(replies.length).toBeLessThanOrEqual(10);
    }
  });

  it("returns a copy, so a caller cannot corrupt the library", () => {
    const first = suggestMessages("lead_magnet", "friendly");
    first.pop();
    expect(suggestMessages("lead_magnet", "friendly").length).toBe(
      DM_MESSAGES.lead_magnet.friendly.length
    );
  });

  it("wraps the message index so a show-me-another button never runs out", () => {
    const options = suggestMessages("booking", "hype");
    expect(suggestMessage("booking", "hype", options.length)).toBe(options[0]);
    expect(suggestMessage("booking", "hype", -1)).toBe(options[options.length - 1]);
  });

  it("renders through the real sender without leaving a token behind", () => {
    const rendered = renderMessageWithTracking({
      message: suggestMessage("lead_magnet", "friendly"),
      commenterName: "Maya",
      trackedLinks: [{ slug: "abc123", destinationUrl: "https://example.com/guide" }],
      baseUrl: "https://myreply.test",
    });

    expect(rendered).toContain("Maya");
    expect(rendered).toContain("https://myreply.test/r/abc123");
    expect(rendered).not.toContain("{");
  });

  it("describes every tone in the picker", () => {
    expect(TONE_OPTIONS.map((option) => option.id)).toEqual([...TONE_IDS]);
    for (const tone of TONE_IDS) {
      const option = getToneOption(tone);
      expect(option.id).toBe(tone);
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
      expect(option.sample.length).toBeGreaterThan(0);
    }
  });

  it("covers every goal in PUBLIC_REPLY_MESSAGES and DM_MESSAGES", () => {
    expect(Object.keys(DM_MESSAGES).sort()).toEqual([...GOAL_IDS].sort());
    expect(Object.keys(PUBLIC_REPLY_MESSAGES).sort()).toEqual([...GOAL_IDS].sort());
  });
});

describe("suggestions: keywords", () => {
  const CAPTION =
    "New pricing guide is live. Comment PRICE below and I will send the breakdown " +
    "straight to your DMs. #pricing #smallbusiness @myfriend https://example.com/x";

  it("never returns a blocklisted word", () => {
    const captions: Array<string | null> = [
      null,
      "",
      "   ",
      "I love this so much, the best thing ever, wow amazing",
      "the and for you your with that this these those are was were",
      CAPTION,
      "Comment GUIDE for the free download",
    ];

    for (const goal of GOAL_IDS) {
      for (const caption of captions) {
        for (const word of suggestKeywords(caption, goal)) {
          expect(isBlockedKeyword(word), `${goal}: ${word}`).toBe(false);
        }
      }
    }
  });

  it("always returns at least three and never more than six", () => {
    const captions: Array<string | null> = [
      null,
      "",
      "the and for you",
      CAPTION,
      "word ".repeat(200),
      "GUIDE PLAN SYSTEM BUNDLE TEMPLATE CHECKLIST WORKSHOP MASTERCLASS BLUEPRINT",
    ];

    for (const goal of GOAL_IDS) {
      for (const caption of captions) {
        const suggestions = suggestKeywords(caption, goal);
        expect(suggestions.length).toBeGreaterThanOrEqual(MIN_KEYWORD_SUGGESTIONS);
        expect(suggestions.length).toBeLessThanOrEqual(MAX_KEYWORD_SUGGESTIONS);
      }
    }
  });

  it("returns uppercase single words with no duplicates", () => {
    for (const goal of GOAL_IDS) {
      const suggestions = suggestKeywords(CAPTION, goal);
      const seen = new Set<string>();
      for (const word of suggestions) {
        expect(word).toBe(word.toUpperCase());
        expect(word).not.toContain(" ");
        expect(seen.has(word.toLowerCase())).toBe(false);
        seen.add(word.toLowerCase());
      }
    }
  });

  it("puts the word the caption explicitly asks for first", () => {
    expect(suggestKeywords("Comment GUIDE and I will send it over", "lead_magnet")[0]).toBe(
      "GUIDE"
    );
    expect(
      suggestKeywords("type BOOK below to grab a slot this week", "booking")[0]
    ).toBe("BOOK");
  });

  it("drops hashtags, mentions, links, emoji and anything under three characters", () => {
    const suggestions = suggestKeywords(
      "so 🔥 go to https://example.com/launch-bundle #launchday @coach me up ok",
      "lead_magnet"
    );

    expect(suggestions).not.toContain("LAUNCHDAY");
    expect(suggestions).not.toContain("COACH");
    expect(suggestions).not.toContain("EXAMPLE");
    expect(suggestions).not.toContain("HTTPS");
    expect(suggestions).not.toContain("OK");
    expect(suggestions).not.toContain("UP");
  });

  it("mines the caption before falling back to the goal defaults", () => {
    const suggestions = suggestKeywords(
      "Full BREAKDOWN of the retainer model inside",
      "price_question"
    );
    expect(suggestions).toContain("BREAKDOWN");
    expect(suggestions).toContain("PRICE");
  });

  it("falls back cleanly to goal defaults for an empty caption", () => {
    for (const goal of GOAL_IDS) {
      const suggestions = suggestKeywords(null, goal);
      expect(suggestions[0]).toBe(GOAL_KEYWORDS[goal][0]);
    }
  });

  it("keeps every curated goal keyword out of the blocklist", () => {
    for (const goal of GOAL_IDS) {
      expect(GOAL_KEYWORDS[goal].length).toBeGreaterThanOrEqual(
        MIN_KEYWORD_SUGGESTIONS
      );
      for (const word of GOAL_KEYWORDS[goal]) {
        expect(isBlockedKeyword(word), `${goal}: ${word}`).toBe(false);
      }
    }
  });

  it("blocks the words that would fire on unrelated comments", () => {
    for (const word of ["the", "this", "love", "wow", "nice", "amazing"]) {
      expect(isBlockedKeyword(word), word).toBe(true);
      expect(isBlockedKeyword(word.toUpperCase()), word).toBe(true);
    }
    expect(KEYWORD_BLOCKLIST.length).toBeGreaterThan(50);
  });

  it("suggests keywords the real matcher would actually match", () => {
    const suggestions = suggestKeywords("Comment GUIDE for the checklist", "lead_magnet");
    const result = matchKeywords("guide please", suggestions, true);
    expect(result.matched).toBe(true);
    expect(result.matchedKeyword).toBe("GUIDE");
  });
});

describe("suggestions: presets", () => {
  it("explains every condition and carries a machine shape", () => {
    expect(CONDITION_PRESETS.length).toBe(5);
    for (const preset of CONDITION_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.explanation.length).toBeGreaterThan(0);
      expect(preset.rule.field.length).toBeGreaterThan(0);
      expect(getConditionPreset(preset.id)).toEqual(preset);
    }
  });

  it("puts the VIP threshold at more than ten thousand followers", () => {
    const vip = getConditionPreset("vip");
    expect(vip?.rule).toEqual({
      field: "followerCount",
      operator: "gt",
      value: 10_000,
    });
  });

  it("keeps every follow-up option inside 23 hours", () => {
    expect(MAX_FOLLOW_UP_DELAY_MINUTES).toBe(23 * 60);
    for (const preset of FOLLOW_UP_TIMING_PRESETS) {
      expect(preset.delayMinutes).toBeGreaterThanOrEqual(0);
      expect(preset.delayMinutes, preset.id).toBeLessThanOrEqual(
        MAX_FOLLOW_UP_DELAY_MINUTES
      );
      // Well clear of the 1440 boundary the create route allows.
      expect(preset.delayMinutes).toBeLessThan(1440);
      expect(getFollowUpTimingPreset(preset.id)).toEqual(preset);
    }
  });

  it("clamps any delay into the range the sender can honour", () => {
    expect(clampFollowUpDelayMinutes(-5)).toBe(0);
    expect(clampFollowUpDelayMinutes(0)).toBe(0);
    expect(clampFollowUpDelayMinutes(61.9)).toBe(61);
    expect(clampFollowUpDelayMinutes(1440)).toBe(MAX_FOLLOW_UP_DELAY_MINUTES);
    expect(clampFollowUpDelayMinutes(99_999)).toBe(MAX_FOLLOW_UP_DELAY_MINUTES);
    expect(clampFollowUpDelayMinutes(Number.NaN)).toBe(0);
  });

  it("offers four business-hours choices with sane windows", () => {
    expect(BUSINESS_HOURS_PRESETS.map((p) => p.id)).toEqual([
      "always_on",
      "weekdays_9_5",
      "weekends_too",
      "my_timezone",
    ]);

    for (const preset of BUSINESS_HOURS_PRESETS) {
      expect(preset.explanation.length).toBeGreaterThan(0);
      expect(preset.window.startHour).toBeGreaterThanOrEqual(0);
      expect(preset.window.endHour).toBeLessThanOrEqual(24);
      expect(preset.window.startHour).toBeLessThan(preset.window.endHour);
      expect(preset.window.days.length).toBeGreaterThan(0);
      expect(getBusinessHoursPreset(preset.id)).toEqual(preset);
    }
  });

  it("lets always-on send at 3am on a Sunday and 9 to 5 refuse it", () => {
    const sundayEarly = new Date(2026, 8, 6, 3, 0, 0);
    const tuesdayMidday = new Date(2026, 8, 8, 12, 0, 0);

    const always = getBusinessHoursPreset("always_on");
    const weekdays = getBusinessHoursPreset("weekdays_9_5");
    expect(always).not.toBeNull();
    expect(weekdays).not.toBeNull();
    if (!always || !weekdays) return;

    expect(isWithinBusinessHours(always.window, sundayEarly)).toBe(true);
    expect(isWithinBusinessHours(weekdays.window, sundayEarly)).toBe(false);
    expect(isWithinBusinessHours(weekdays.window, tuesdayMidday)).toBe(true);
  });
});

describe("suggestions: goals", () => {
  it("shows between four and six cards, one per goal", () => {
    expect(GOAL_CARDS.length).toBeGreaterThanOrEqual(4);
    expect(GOAL_CARDS.length).toBeLessThanOrEqual(6);
    expect(GOAL_CARDS.map((card) => card.id).sort()).toEqual([...GOAL_IDS].sort());
  });

  it("fills in every card with copy and a keyword set", () => {
    for (const card of GOAL_CARDS) {
      expect(card.label.length).toBeGreaterThan(0);
      expect(card.description.length).toBeGreaterThan(0);
      expect(card.example.length).toBeGreaterThan(0);
      expect(card.defaultKeywords.length).toBeGreaterThanOrEqual(
        MIN_KEYWORD_SUGGESTIONS
      );
      expect(getGoalCard(card.id)).toEqual(card);
    }
  });

  it("presets only values the create route will accept", () => {
    for (const card of GOAL_CARDS) {
      const { presets } = card;
      expect(presets.goal.length).toBeLessThanOrEqual(120);
      expect(presets.keywords.length).toBeLessThanOrEqual(10);
      expect(presets.followUpDelayMinutes).toBeLessThanOrEqual(
        MAX_FOLLOW_UP_DELAY_MINUTES
      );
      if (presets.linkButtonLabel !== null) {
        expect(presets.linkButtonLabel.length).toBeLessThanOrEqual(20);
      }
      // An opening DM needs a message and a button label, so no card turns it
      // on by default.
      expect(presets.openingDmEnabled).toBe(false);
      // A follow-up with no follow-up message written is an empty DM.
      expect(presets.followUpEnabled).toBe(false);
    }
  });

  it("builds a draft with no blanks in it", () => {
    for (const goal of GOAL_IDS) {
      for (const tone of TONE_IDS) {
        const draft = buildAutomationDraft({ goal, tone, caption: null });
        expect(draft.name.length).toBeGreaterThan(0);
        expect(draft.name.length).toBeLessThanOrEqual(100);
        expect(draft.goal.length).toBeGreaterThan(0);
        expect(draft.dmMessage.length).toBeGreaterThan(0);
        expect(draft.dmMessage.length).toBeLessThanOrEqual(1000);
        expect(draft.publicReplyMessages.length).toBeGreaterThanOrEqual(5);
        expect(draft.publicReplyMessages.length).toBeLessThanOrEqual(10);
        // The route needs matchAnyWord or at least one keyword.
        expect(draft.matchAnyWord || draft.keywords.length >= 1).toBe(true);
        expect(draft.keywords.length).toBeLessThanOrEqual(10);
        expect(findUnknownPlaceholders(draft.dmMessage)).toEqual([]);
      }
    }
  });

  it("uses the caption when the draft has a post attached", () => {
    const draft = buildAutomationDraft({
      goal: "lead_magnet",
      tone: "short",
      caption: "Comment TEMPLATE and I will send the swipe file",
    });
    expect(draft.keywords[0]).toBe("TEMPLATE");
    expect(draft.dmMessage).toBe(suggestMessage("lead_magnet", "short", 0));
  });

  it("defaults the tone rather than leaving the message blank", () => {
    const draft = buildAutomationDraft({ goal: "faq" });
    expect(draft.dmMessage).toBe(suggestMessage("faq", DEFAULT_TONE, 0));
  });
});

describe("suggestions: tone", () => {
  it("defaults to friendly", () => {
    expect(DEFAULT_TONE).toBe("friendly");
    expect(getWorkspaceTone(null)).toBe("friendly");
    expect(getWorkspaceTone(undefined)).toBe("friendly");
    expect(getWorkspaceTone({})).toBe("friendly");
  });

  it("reads the stored enum and the lowercase id alike", () => {
    expect(getWorkspaceTone({ tone: "HYPE" })).toBe("hype");
    expect(getWorkspaceTone({ tone: "hype" })).toBe("hype");
    expect(resolveTone("  Professional ")).toBe("professional");
  });

  it("never throws on junk, it falls back", () => {
    for (const junk of [null, undefined, 42, {}, [], "nonsense", ""]) {
      expect(resolveTone(junk)).toBe(DEFAULT_TONE);
    }
  });

  it("round-trips every tone through the stored spelling", () => {
    for (const tone of TONE_IDS) {
      const stored = toneToWorkspaceTone(tone);
      expect(WORKSPACE_TONE_VALUES).toContain(stored);
      expect(resolveTone(stored)).toBe(tone);
    }
    expect(WORKSPACE_TONE_VALUES.length).toBe(TONE_IDS.length);
  });

  it("narrows unknown input for goals and tones", () => {
    expect(isGoal("booking")).toBe(true);
    expect(isGoal("nope")).toBe(false);
    expect(isGoal(7)).toBe(false);
    expect(isTone("warm")).toBe(true);
    expect(isTone("WARM")).toBe(false);
  });
});
