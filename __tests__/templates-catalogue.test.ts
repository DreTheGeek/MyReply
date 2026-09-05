import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_TEMPLATES,
  buildTemplateInstallHref,
} from "../lib/templates/campaign-templates";
import {
  TEMPLATE_CATALOGUE,
  TEMPLATE_GROUPS,
  getTemplate,
  getTemplateSlugs,
  getTemplatesByGroup,
  templateCopyStrings,
} from "../lib/templates/catalogue";
import {
  findBlockedCapabilityClaims,
  findUnsupportedPlaceholders,
} from "../lib/templates/copy-rules";
import {
  buildGallerySections,
  describeKeywords,
  describeTrigger,
} from "../lib/templates/gallery";
import { buildInstallPayload } from "../lib/templates/install";

// The limits the create route enforces, restated here so a template that grows
// past one fails in this file rather than at install time.
const MAX_NAME = 100;
const MAX_GOAL = 120;
const MAX_DM = 1000;
const MAX_KEYWORDS = 10;
const MAX_KEYWORD = 50;
const MAX_LINK_BUTTON_LABEL = 20;
const MAX_OPENING_BUTTON_LABEL = 64;
const MAX_FOLLOW_UP_MINUTES = 1440;

// Built from its code point so this file does not itself contain one.
const EM_DASH = String.fromCharCode(0x2014);

describe("template catalogue", () => {
  it("ships the twelve jobs people actually run", () => {
    expect(getTemplateSlugs()).toEqual([
      "lead-magnet",
      "waitlist-signup",
      "giveaway-entry",
      "link-in-bio",
      "product-launch",
      "price-question",
      "booking-request",
      "faq-deflection",
      "restock-alert",
      "vip-routing",
      "new-follower-welcome",
      "story-reply-thanks",
    ]);
  });

  it("gives every template a slug of its own", () => {
    expect(new Set(getTemplateSlugs()).size).toBe(TEMPLATE_CATALOGUE.length);
  });

  it("finds a template by slug and refuses anything else", () => {
    expect(getTemplate("lead-magnet")?.name).toBe("Send my free guide");
    expect(getTemplate("not-a-template")).toBeNull();
    expect(getTemplate(null)).toBeNull();
    expect(getTemplate(undefined)).toBeNull();
    expect(getTemplate("")).toBeNull();
  });

  it("puts every template in a group, and leaves no group empty", () => {
    const sections = getTemplatesByGroup();
    const grouped = sections.flatMap((section) => section.templates);

    expect(grouped).toHaveLength(TEMPLATE_CATALOGUE.length);
    expect(sections).toHaveLength(TEMPLATE_GROUPS.length);
    for (const section of sections) {
      expect(section.templates.length).toBeGreaterThan(0);
    }
  });

  it("describes something real for every card", () => {
    for (const section of buildGallerySections()) {
      for (const card of section.templates) {
        expect(card.name).toBeTruthy();
        expect(card.description).toBeTruthy();
        expect(card.audience).toBeTruthy();
        expect(card.goal).toBeTruthy();
        expect(card.triggerLabel).toBeTruthy();
        expect(card.keywordLabel).toBeTruthy();
        expect(card.dmMessage).toBe(
          getTemplate(card.slug)?.preset.dmMessage
        );
      }
    }
  });
});

describe("template copy", () => {
  it("uses no placeholder the renderer would not substitute", () => {
    for (const template of TEMPLATE_CATALOGUE) {
      for (const copy of templateCopyStrings(template)) {
        expect({
          slug: template.slug,
          unsupported: findUnsupportedPlaceholders(copy),
        }).toEqual({ slug: template.slug, unsupported: [] });
      }
    }
  });

  it("promises nothing Instagram blocks", () => {
    for (const template of TEMPLATE_CATALOGUE) {
      for (const copy of templateCopyStrings(template)) {
        expect({
          slug: template.slug,
          claims: findBlockedCapabilityClaims(copy),
        }).toEqual({ slug: template.slug, claims: [] });
      }
    }
  });

  it("catches a blocked promise when one is written", () => {
    expect(
      findBlockedCapabilityClaims("I will DM you when it is back in stock.")
    ).not.toHaveLength(0);
    expect(
      findBlockedCapabilityClaims("I will send you a reminder before it closes.")
    ).not.toHaveLength(0);
    expect(
      findBlockedCapabilityClaims("Part one of three, the rest lands tomorrow.")
    ).not.toHaveLength(0);
    expect(
      findBlockedCapabilityClaims("You can check out right here in this chat.")
    ).not.toHaveLength(0);
  });

  it("catches an unsupported placeholder when one is written", () => {
    expect(findUnsupportedPlaceholders("Hi {first_name}, here is {link}")).toEqual(
      ["{first_name}"]
    );
    expect(findUnsupportedPlaceholders("Hi {username}, here is {link}")).toEqual(
      []
    );
  });

  it("writes real copy rather than filler", () => {
    for (const template of TEMPLATE_CATALOGUE) {
      const copy = templateCopyStrings(template);
      expect(copy.length).toBeGreaterThan(0);

      for (const text of copy) {
        expect(text.trim()).toBe(text);
        // A public comment reply is meant to be a few words. Everything else
        // is a message to a person and has to say something.
        const isPublicReply =
          template.preset.publicReplyMessages.includes(text);
        expect(text.length).toBeGreaterThan(isPublicReply ? 8 : 60);
        expect(text.toLowerCase()).not.toContain("lorem");
        expect(text.toLowerCase()).not.toContain("your message here");
        expect(text.toLowerCase()).not.toContain("yourlink.com");
        // Em dashes do not exist in this codebase, written as an escape so
        // this guard does not itself smuggle one in.
        expect(text).not.toContain(EM_DASH);
      }

      expect(template.preset.dmMessage).toContain("{username}");
    }
  });
});

describe("template presets map onto real Automation columns", () => {
  it("stays inside every limit the create route enforces", () => {
    for (const template of TEMPLATE_CATALOGUE) {
      const { preset } = template;

      expect(template.name.length).toBeLessThanOrEqual(MAX_NAME);
      expect(template.goal.length).toBeLessThanOrEqual(MAX_GOAL);
      expect(preset.dmMessage.length).toBeLessThanOrEqual(MAX_DM);
      expect(preset.keywords.length).toBeLessThanOrEqual(MAX_KEYWORDS);
      expect(preset.publicReplyMessages.length).toBeLessThanOrEqual(10);
      expect(preset.followUpDelayMinutes).toBeGreaterThanOrEqual(0);
      expect(preset.followUpDelayMinutes).toBeLessThanOrEqual(
        MAX_FOLLOW_UP_MINUTES
      );

      for (const keyword of preset.keywords) {
        expect(keyword.length).toBeGreaterThan(0);
        expect(keyword.length).toBeLessThanOrEqual(MAX_KEYWORD);
        // A multi word keyword is a different matcher problem, so templates
        // stay on single words.
        expect(keyword).not.toContain(" ");
      }

      if (preset.linkButtonLabel) {
        expect(preset.linkButtonLabel.length).toBeLessThanOrEqual(
          MAX_LINK_BUTTON_LABEL
        );
      }
      if (preset.openingDmButtonLabel) {
        expect(preset.openingDmButtonLabel.length).toBeLessThanOrEqual(
          MAX_OPENING_BUTTON_LABEL
        );
      }
      if (preset.referralRef) {
        expect(preset.referralRef.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("gives every template a trigger and a match rule the route accepts", () => {
    for (const template of TEMPLATE_CATALOGUE) {
      const { preset } = template;

      const hasTrigger =
        preset.matchAnyPost ||
        preset.dmTriggerEnabled ||
        preset.storyReplyEnabled ||
        preset.storyMentionEnabled ||
        preset.liveCommentEnabled ||
        preset.defaultReplyEnabled ||
        Boolean(preset.referralRef?.trim());

      expect({ slug: template.slug, hasTrigger }).toEqual({
        slug: template.slug,
        hasTrigger: true,
      });

      const hasMatchRule = preset.matchAnyWord || preset.keywords.length >= 1;
      expect({ slug: template.slug, hasMatchRule }).toEqual({
        slug: template.slug,
        hasMatchRule: true,
      });

      // An opening DM is only valid with both a message and a button label.
      if (preset.openingDmEnabled) {
        expect(preset.openingDmMessage?.trim()).toBeTruthy();
        expect(preset.openingDmButtonLabel?.trim()).toBeTruthy();
      }

      // A follow-up and a follow prompt only exist when switched on.
      if (!preset.followUpEnabled) {
        expect(preset.followUpMessage).toBeNull();
      } else {
        expect(preset.followUpMessage?.trim()).toBeTruthy();
      }
      if (!preset.requireFollow) {
        expect(preset.followPromptMessage).toBeNull();
      }

      // A link template delivers its URL as a button, so it needs a label.
      if (template.needsLink) {
        expect(preset.linkButtonLabel?.trim()).toBeTruthy();
      }

      // A public reply only makes sense where there is a comment to reply to.
      if (preset.publicReplyEnabled) {
        expect(preset.publicReplyMessages.length).toBeGreaterThan(0);
      } else {
        expect(preset.publicReplyMessages).toEqual([]);
      }
    }
  });

  it("never leaves a {link} token in a message that has no link", () => {
    // The worker substitutes {link} only when a tracked link exists. Without
    // one it would deliver the literal token, so no template carries it.
    for (const template of TEMPLATE_CATALOGUE) {
      for (const copy of templateCopyStrings(template)) {
        expect(copy).not.toContain("{link}");
      }
    }
  });

  it("describes the trigger it actually installs", () => {
    const faq = getTemplate("faq-deflection");
    const story = getTemplate("story-reply-thanks");
    const welcome = getTemplate("new-follower-welcome");

    expect(describeTrigger(faq!)).toContain("DMs nothing else answered");
    expect(describeTrigger(story!)).toContain("Story replies");
    expect(describeTrigger(welcome!)).toContain("Chats opened from your link");
    expect(describeKeywords(faq!)).toBe("Any message");
    expect(describeKeywords(getTemplate("lead-magnet")!)).toBe(
      "GUIDE, FREE, SEND, CHECKLIST"
    );
  });
});

describe("install payload", () => {
  const account = "ig_account_1";

  it("defaults to any post when no post is chosen", () => {
    const payload = buildInstallPayload(getTemplate("lead-magnet")!, {
      instagramAccountId: account,
    });

    expect(payload.matchAnyPost).toBe(true);
    expect(payload.postId).toBeNull();
    expect(payload.postUrl).toBeNull();
    expect(payload.pendingNextReel).toBe(false);
    expect(payload.name).toBe("Send my free guide");
    expect(payload.goal).toBe("Lead magnet delivery");
  });

  it("binds to a post when one is chosen", () => {
    const payload = buildInstallPayload(getTemplate("lead-magnet")!, {
      instagramAccountId: account,
      postId: "17900000000000000",
      postUrl: "https://instagram.com/p/abc/",
    });

    expect(payload.matchAnyPost).toBe(false);
    expect(payload.postId).toBe("17900000000000000");
    expect(payload.postUrl).toBe("https://instagram.com/p/abc/");
  });

  it("ignores a post on a template that has no post trigger", () => {
    const payload = buildInstallPayload(getTemplate("story-reply-thanks")!, {
      instagramAccountId: account,
      postId: "17900000000000000",
    });

    expect(payload.matchAnyPost).toBe(false);
    expect(payload.postId).toBeNull();
    expect(payload.storyReplyEnabled).toBe(true);
  });

  it("installs a link template switched off until it has a link", () => {
    const withoutLink = buildInstallPayload(getTemplate("price-question")!, {
      instagramAccountId: account,
    });
    expect(withoutLink.isActive).toBe(false);
    expect(withoutLink.trackedDestinationUrl).toBeNull();

    const withLink = buildInstallPayload(getTemplate("price-question")!, {
      instagramAccountId: account,
      destinationUrl: "https://example.com/pricing",
    });
    expect(withLink.isActive).toBe(true);
    expect(withLink.trackedDestinationUrl).toBe("https://example.com/pricing");
  });

  it("installs a template that needs no link switched on", () => {
    const payload = buildInstallPayload(getTemplate("giveaway-entry")!, {
      instagramAccountId: account,
    });

    expect(payload.isActive).toBe(true);
    expect(payload.trackedDestinationUrl).toBeNull();
  });

  it("clears keywords when the template matches any word", () => {
    const payload = buildInstallPayload(getTemplate("faq-deflection")!, {
      instagramAccountId: account,
    });

    expect(payload.matchAnyWord).toBe(true);
    expect(payload.keywords).toEqual([]);
    expect(payload.defaultReplyEnabled).toBe(true);
    expect(payload.publicReplyEnabled).toBe(false);
    expect(payload.publicReplyMessages).toEqual([]);
  });

  it("does not hand the caller the catalogue's own arrays to mutate", () => {
    const template = getTemplate("lead-magnet")!;
    const payload = buildInstallPayload(template, {
      instagramAccountId: account,
    });

    payload.keywords.push("MUTATED");
    expect(template.preset.keywords).not.toContain("MUTATED");
  });
});

describe("the public pages point at real templates", () => {
  it("gives every marketing page a catalogue entry to install", () => {
    for (const marketing of CAMPAIGN_TEMPLATES) {
      expect({
        slug: marketing.slug,
        installs: Boolean(getTemplate(marketing.installSlug)),
      }).toEqual({ slug: marketing.slug, installs: true });
    }
  });

  it("sends every marketing CTA into the product rather than to a signup form", () => {
    for (const marketing of CAMPAIGN_TEMPLATES) {
      expect(buildTemplateInstallHref(marketing)).toBe(
        `/templates?install=${marketing.installSlug}`
      );
    }
  });
});
