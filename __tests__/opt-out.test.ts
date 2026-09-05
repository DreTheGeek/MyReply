import { describe, expect, it } from "vitest";

import { canMessageContact, detectOptOutIntent } from "../lib/messaging/opt-out";

describe("detectOptOutIntent", () => {
  it("catches the words people actually type", () => {
    for (const text of [
      "STOP",
      "stop",
      "Stop.",
      "STOP!",
      "unsubscribe",
      "Unsubscribe.",
      "cancel",
      "quit",
      "opt out",
      "optout",
      "remove me",
      "leave me alone",
      "no more",
      "unsub",
    ]) {
      expect(detectOptOutIntent(text), text).toBe("opt_out");
    }
  });

  it("catches the keyword wrapped in politeness", () => {
    for (const text of [
      "please stop",
      "stop please",
      "Stop now",
      "please stop now",
      "stop all",
      "remove me please",
    ]) {
      expect(detectOptOutIntent(text), text).toBe("opt_out");
    }
  });

  it("catches an emoji stuck to the keyword", () => {
    expect(detectOptOutIntent("🛑 stop")).toBe("opt_out");
    expect(detectOptOutIntent("stop 🙏")).toBe("opt_out");
  });

  it("lets someone back in", () => {
    for (const text of ["start", "START", "unstop", "resume", "subscribe", "opt in"]) {
      expect(detectOptOutIntent(text), text).toBe("opt_in");
    }
  });

  // The failure that would matter most in the other direction: silently
  // unsubscribing someone who was having a conversation.
  it("does not fire on a sentence that merely contains the word", () => {
    for (const text of [
      "stop by the shop tomorrow and say hi",
      "don't stop, this is great",
      "I can't stop using this product honestly",
      "where is the bus stop near you",
      "can you send me the link, I'll start there",
      "cancel my appointment for Tuesday please",
    ]) {
      expect(detectOptOutIntent(text), text).toBeNull();
    }
  });

  it("ignores empty and absent messages", () => {
    expect(detectOptOutIntent("")).toBeNull();
    expect(detectOptOutIntent("   ")).toBeNull();
    expect(detectOptOutIntent(null)).toBeNull();
    expect(detectOptOutIntent(undefined)).toBeNull();
    expect(detectOptOutIntent("🙂")).toBeNull();
  });

  it("treats an ordinary reply as an ordinary reply", () => {
    for (const text of [
      "yes please",
      "thanks!",
      "how much is it",
      "PRICE",
      "sent",
      "ok",
    ]) {
      expect(detectOptOutIntent(text), text).toBeNull();
    }
  });
});

describe("canMessageContact", () => {
  it("blocks a contact who asked to stop", () => {
    expect(canMessageContact(new Date())).toBe(false);
  });

  it("allows a contact who never did", () => {
    expect(canMessageContact(null)).toBe(true);
    expect(canMessageContact(undefined)).toBe(true);
  });
});
