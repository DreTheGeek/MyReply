import { describe, expect, it } from "vitest";

import {
  referencesLink,
  resolveIsActive,
} from "../lib/campaigns/link-readiness";

describe("referencesLink", () => {
  it("finds the token in any outgoing message, whatever the case", () => {
    expect(referencesLink({ dmMessage: "Here it is: {link}" })).toBe(true);
    expect(referencesLink({ openingDmMessage: "Tap for {LINK}" })).toBe(true);
    expect(referencesLink({ followUpMessage: "Still here? {Link}" })).toBe(true);
    expect(referencesLink({ followPromptMessage: "Follow then {link}" })).toBe(
      true
    );
  });

  it("does not fire on a message that simply says the word link", () => {
    expect(referencesLink({ dmMessage: "The link is in my bio." })).toBe(false);
  });

  it("ignores null and missing fields", () => {
    expect(referencesLink({})).toBe(false);
    expect(referencesLink({ dmMessage: null, followUpMessage: null })).toBe(
      false
    );
  });
});

describe("resolveIsActive", () => {
  const promisesLink = { dmMessage: "Here is the guide: {link}" };
  const plain = { dmMessage: "Thanks for commenting." };

  // The bug this exists for: onboarding built the draft paused, the client
  // re-sent isActive true, and the campaign went live sending the literal
  // characters "{link}" to strangers.
  it("pauses a campaign that offers a link it does not have", () => {
    expect(resolveIsActive(true, promisesLink, false)).toEqual({
      isActive: false,
      pausedForMissingLink: true,
    });
  });

  it("lets it go live once a tracked link exists", () => {
    expect(resolveIsActive(true, promisesLink, true)).toEqual({
      isActive: true,
      pausedForMissingLink: false,
    });
  });

  it("leaves a campaign with no link token alone", () => {
    expect(resolveIsActive(true, plain, false)).toEqual({
      isActive: true,
      pausedForMissingLink: false,
    });
  });

  it("never turns a campaign on that the caller asked to be off", () => {
    expect(resolveIsActive(false, plain, true)).toEqual({
      isActive: false,
      pausedForMissingLink: false,
    });
  });

  it("catches the token in a follow-up even when the first DM is clean", () => {
    expect(
      resolveIsActive(
        true,
        { dmMessage: "Thanks!", followUpMessage: "Here you go {link}" },
        false
      )
    ).toEqual({ isActive: false, pausedForMissingLink: true });
  });
});
