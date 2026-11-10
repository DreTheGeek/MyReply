/**
 * The platforms' messaging rules (lib/channels/windows.ts), tested directly.
 *
 * Meta's rules for Instagram and Messenger: one private reply per comment,
 * within 7 days; a 24 hour window after the person's last message, tap or
 * link arrival; past that only a human, in the 7 day human agent window, and
 * only with the Human Agent feature approved.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getChannelCapabilities } from "../lib/channels/capabilities";
import {
  isHumanAgentApproved,
  messagingWindow,
  privateReplyAllowed,
} from "../lib/channels/windows";

const caps = getChannelCapabilities("INSTAGRAM");
const now = new Date("2026-11-10T12:00:00Z");
const hoursAgo = (h: number): Date => new Date(now.getTime() - h * 3_600_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("private reply window", () => {
  it("allows a private reply inside 7 days of the comment", () => {
    expect(privateReplyAllowed(caps, hoursAgo(24 * 7 - 1), now)).toBe(true);
  });

  it("refuses one past 7 days", () => {
    expect(privateReplyAllowed(caps, hoursAgo(24 * 7 + 1), now)).toBe(false);
  });

  it("lets the platform decide when the comment's age is unknown", () => {
    expect(privateReplyAllowed(caps, null, now)).toBe(true);
  });
});

describe("messaging window, automations", () => {
  it("is open for 24 hours after the person's last message", () => {
    expect(
      messagingWindow({ capabilities: caps, lastInboundAt: hoursAgo(23), now, sender: "automation" })
    ).toEqual({ allowed: true, humanAgentTag: false });
  });

  it("closes after 24 hours, even when the human agent feature is approved", () => {
    expect(
      messagingWindow({
        capabilities: caps,
        lastInboundAt: hoursAgo(25),
        now,
        sender: "automation",
        humanAgentApproved: true,
      })
    ).toEqual({ allowed: false, reason: "window_closed" });
  });

  it("is closed for someone who never wrote in", () => {
    expect(
      messagingWindow({ capabilities: caps, lastInboundAt: null, now, sender: "automation" }).allowed
    ).toBe(false);
  });
});

describe("messaging window, a person in the inbox", () => {
  it("is an ordinary reply inside 24 hours", () => {
    expect(
      messagingWindow({ capabilities: caps, lastInboundAt: hoursAgo(2), now, sender: "human" })
    ).toEqual({ allowed: true, humanAgentTag: false });
  });

  it("is refused after 24 hours without the human agent approval", () => {
    expect(
      messagingWindow({ capabilities: caps, lastInboundAt: hoursAgo(30), now, sender: "human" })
    ).toEqual({ allowed: false, reason: "window_closed" });
  });

  it("carries the human agent tag after 24 hours, within 7 days, when approved", () => {
    expect(
      messagingWindow({
        capabilities: caps,
        lastInboundAt: hoursAgo(30),
        now,
        sender: "human",
        humanAgentApproved: true,
      })
    ).toEqual({ allowed: true, humanAgentTag: true });
  });

  it("is refused past 7 days even with approval", () => {
    expect(
      messagingWindow({
        capabilities: caps,
        lastInboundAt: hoursAgo(24 * 7 + 1),
        now,
        sender: "human",
        humanAgentApproved: true,
      })
    ).toEqual({ allowed: false, reason: "human_agent_window_closed" });
  });
});

describe("human agent approval flag", () => {
  it("is off unless the owner turned it on after App Review", () => {
    expect(isHumanAgentApproved()).toBe(false);
    vi.stubEnv("META_HUMAN_AGENT_APPROVED", "yes");
    expect(isHumanAgentApproved()).toBe(false);
    vi.stubEnv("META_HUMAN_AGENT_APPROVED", "true");
    expect(isHumanAgentApproved()).toBe(true);
  });
});
