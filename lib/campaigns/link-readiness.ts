/**
 * A campaign must never go live promising a link it does not have.
 *
 * `{link}` is substituted with the tracked URL at send time. When there is no
 * tracked link, `lib/tracking/message.ts` returns the message unchanged, so
 * the token itself is what reaches the customer:
 *
 *   "Hey Sam, thanks for commenting. Here is the guide: {link}"
 *
 * The onboarding suggester already knew this and installed such drafts paused,
 * but the client re-sent `isActive: true` and undid it. Rather than fix that
 * one caller, the rule lives here and the create route applies it, so every
 * path is covered at once: onboarding, the builder, the template gallery, the
 * v1 API and the MCP tools.
 */

/** Every message field that goes to a person and gets {link} substituted. */
export interface LinkDependentMessages {
  dmMessage?: string | null;
  openingDmMessage?: string | null;
  followUpMessage?: string | null;
  followPromptMessage?: string | null;
}

const LINK_TOKEN = /\{link\}/i;

/** True when any outgoing message references a link. */
export function referencesLink(messages: LinkDependentMessages): boolean {
  return [
    messages.dmMessage,
    messages.openingDmMessage,
    messages.followUpMessage,
    messages.followPromptMessage,
  ].some((message) => typeof message === "string" && LINK_TOKEN.test(message));
}

/**
 * Whether this campaign may be active, given the links it actually has.
 *
 * Returns the flag to store rather than throwing, because refusing the whole
 * request would lose work the person already did. Saving it paused keeps the
 * campaign and stops the send, which is the outcome they would choose.
 */
export function resolveIsActive(
  requestedActive: boolean,
  messages: LinkDependentMessages,
  hasTrackedLink: boolean
): { isActive: boolean; pausedForMissingLink: boolean } {
  if (!requestedActive) {
    return { isActive: false, pausedForMissingLink: false };
  }
  if (hasTrackedLink || !referencesLink(messages)) {
    return { isActive: true, pausedForMissingLink: false };
  }
  return { isActive: false, pausedForMissingLink: true };
}
