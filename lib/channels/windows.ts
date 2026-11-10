import type { ChannelCapabilities } from "./capabilities";

/**
 * When a platform lets the engine message someone. Platform neutral: each
 * platform's numbers come from its capabilities.
 *
 * The rules, as Meta states them for Instagram and Messenger:
 *   - A comment opens one private reply, within `privateReplyDays` of the
 *     comment. Nothing more may follow until the person answers.
 *   - A person's message, button tap or link arrival opens the standard
 *     window: `standardHours` after it, the account may write to them.
 *   - Past that, only a human (never an automation) may reply, for
 *     `humanAgentDays`, and only where the platform approved the app for it.
 *
 * Every function here is pure and takes `now`, so the rules are tested
 * directly rather than through the worker.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * May this comment still get its private reply? Unknown creation time is
 * allowed: the platform is the final judge and refuses a stale one, which the
 * worker records as a confirmed refusal.
 */
export function privateReplyAllowed(
  capabilities: ChannelCapabilities,
  commentCreatedAt: Date | null,
  now: Date
): boolean {
  const days = capabilities.window.privateReplyDays;
  if (days === null || commentCreatedAt === null) return true;
  return now.getTime() - commentCreatedAt.getTime() <= days * DAY_MS;
}

export type WindowDecision =
  | { allowed: true; humanAgentTag: boolean }
  | { allowed: false; reason: "window_closed" | "human_agent_window_closed" };

/**
 * May the account message this person now?
 *
 * `lastInboundAt` is the last time the person wrote, tapped a button or
 * arrived through a link. Null means the engine has no record of them
 * opening a conversation, which closes the window: an automation may only
 * answer someone who reached out.
 *
 * `sender` separates an automation from a person typing in the inbox. Only a
 * person may use the longer human-agent window, and only when the platform
 * approved the app for it (`humanAgentApproved`). The tag is reported back so
 * the send can carry it.
 */
export function messagingWindow({
  capabilities,
  lastInboundAt,
  now,
  sender,
  humanAgentApproved = false,
}: {
  capabilities: ChannelCapabilities;
  lastInboundAt: Date | null;
  now: Date;
  sender: "automation" | "human";
  humanAgentApproved?: boolean;
}): WindowDecision {
  const { standardHours, humanAgentDays } = capabilities.window;
  if (standardHours === null) return { allowed: true, humanAgentTag: false };
  if (lastInboundAt === null) return { allowed: false, reason: "window_closed" };

  const age = now.getTime() - lastInboundAt.getTime();
  if (age <= standardHours * HOUR_MS) {
    return { allowed: true, humanAgentTag: false };
  }

  if (sender === "human" && humanAgentApproved && humanAgentDays !== null) {
    return age <= humanAgentDays * DAY_MS
      ? { allowed: true, humanAgentTag: true }
      : { allowed: false, reason: "human_agent_window_closed" };
  }

  return { allowed: false, reason: "window_closed" };
}

/**
 * Whether the deployment's Meta app was approved for the Human Agent feature.
 * The owner sets META_HUMAN_AGENT_APPROVED=true only after App Review grants
 * it; until then the tag is never sent.
 */
export function isHumanAgentApproved(): boolean {
  return process.env.META_HUMAN_AGENT_APPROVED === "true";
}
