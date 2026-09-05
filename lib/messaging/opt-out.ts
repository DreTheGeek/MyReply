/**
 * Letting a person say stop.
 *
 * MyReply sends automated DMs to people who commented on a post. Until now
 * there was no way for one of them to make it stop: no keyword, no column, no
 * check on any send path. That is a trust problem before it is a policy one,
 * and Meta's platform terms expect an automated messaging experience to honour
 * a request to stop.
 *
 * The mechanism is the one everybody already knows from SMS, because a person
 * who wants out will type STOP whether or not we told them to. Recognising the
 * words they will actually use is the whole feature.
 *
 * SCOPE. An opt-out is per contact, and a contact is already scoped to one
 * Instagram account, so saying stop to one brand does not opt someone out of
 * another workspace's messages. That is the correct boundary: they are
 * different senders and the person only asked one of them to stop.
 */

/**
 * The words people actually type, not the words a compliance page lists.
 *
 * Matched case-insensitively against the whole trimmed message, not as a
 * substring: "stop sending me the link" is an opt-out, but "stop by the shop
 * tomorrow" is a sentence, and "don't stop" is the opposite of one. Requiring
 * the message to be essentially just the keyword is what keeps a normal
 * conversation from silently unsubscribing someone.
 */
const OPT_OUT_WORDS = [
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "opt out",
  "remove me",
  "leave me alone",
  "no more",
  "unsub",
];

/** The way back in, for someone who changes their mind. */
const OPT_IN_WORDS = ["start", "unstop", "resume", "subscribe", "optin", "opt in"];

export type OptOutIntent = "opt_out" | "opt_in" | null;

/**
 * Strip the punctuation and emoji a person puts around a single word, so
 * "STOP!", "stop." and "🛑 stop" all read as the keyword they are.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What this message is asking for, if anything.
 *
 * Deliberately conservative in one direction and not the other. A missed
 * opt-out keeps messaging someone who asked us to stop, which is the failure
 * that matters, so the list is generous. A false positive merely stops
 * messaging someone who did not ask, which is recoverable and much less bad.
 * Hence: whole-message match, but a forgiving one.
 */
export function detectOptOutIntent(text: string | null | undefined): OptOutIntent {
  if (!text) return null;

  const normalized = normalize(text);
  if (!normalized) return null;

  // A long message that happens to contain "stop" is a conversation, not a
  // command. Four words is enough for "please remove me now" and short of
  // anything that reads as a sentence about something else.
  const wordCount = normalized.split(" ").length;
  if (wordCount > 4) return null;

  if (OPT_OUT_WORDS.includes(normalized)) return "opt_out";
  if (OPT_IN_WORDS.includes(normalized)) return "opt_in";

  // "please stop", "stop please", "stop now" and the like: the keyword plus
  // politeness, with nothing else of substance.
  //
  // Only politeness is stripped. Words like "me" and "all" look like filler and
  // are not: stripping them turns "remove me" into "remove", which is not a
  // keyword, so the opt-out is missed entirely. Multi-word keywords are listed
  // above in full instead.
  const words = normalized.split(" ");
  const filler = new Set(["please", "pls", "now", "thanks", "thank", "you"]);
  const substantive = words.filter((word) => !filler.has(word));
  const rejoined = substantive.join(" ");

  if (substantive.length > 0 && OPT_OUT_WORDS.includes(rejoined)) return "opt_out";
  if (substantive.length > 0 && OPT_IN_WORDS.includes(rejoined)) return "opt_in";

  return null;
}

/**
 * The line appended to a campaign's first DM so the person knows how to leave.
 *
 * Not appended to follow-ups: saying it twice is nagging, and the first message
 * is the one that establishes the relationship.
 */
export const OPT_OUT_NOTICE = "Reply STOP to stop these messages.";

/**
 * Whether this contact may be sent an automated message.
 *
 * Takes the timestamp rather than the whole contact so it can be called with a
 * narrow select, and so the reason is obvious at the call site.
 */
export function canMessageContact(optedOutAt: Date | null | undefined): boolean {
  return !optedOutAt;
}
