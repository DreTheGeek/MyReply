/**
 * The two rules every word in the template catalogue has to pass.
 *
 * This is a leaf module on purpose. It imports nothing, so the catalogue, a
 * route handler and a test can all agree on the same rules without dragging
 * Prisma or NextAuth in behind them.
 */

/**
 * The only tokens the product substitutes. Both are handled in
 * lib/tracking/message.ts: {username} becomes the commenter's name (or
 * "there"), and {link} becomes the campaign's tracked URL. Anything else in
 * braces is delivered to a real person as literal text, so it is banned.
 */
export const SUPPORTED_PLACEHOLDERS = ["username", "link"] as const;

const PLACEHOLDER_PATTERN = /\{([^}]*)\}/g;

/** Every brace token in `text` that the renderer would not substitute. */
export function findUnsupportedPlaceholders(text: string): string[] {
  const found: string[] = [];

  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const token = (match[1] ?? "").trim().toLowerCase();
    const supported = SUPPORTED_PLACEHOLDERS.some(
      (placeholder) => placeholder === token
    );
    if (!supported) found.push(match[0]);
  }

  return found;
}

/**
 * Promises Instagram cannot keep.
 *
 * A message may only be sent inside the 24 hour window that the person's own
 * comment or reply opened, one send per trigger, to that one person. So there
 * is no broadcast, no reminder tomorrow, no drip over a week, and no checkout
 * inside the thread. Copy that promises any of it is a lie we would be putting
 * in a customer's mouth, which is worse than copy that is merely dull.
 */
export const BLOCKED_CAPABILITY_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: "promises a later DM, which the 24 hour window forbids",
    pattern:
      /\b(?:i|we|i'll|we'll|ill|well)\s*(?:will\s+)?(?:dm|message|text|ping)\s+you\s+(?:when|as soon|once|later|again|back)\b/i,
  },
  {
    label: "promises a reminder",
    pattern: /\bremind(?:er|ers|ing)?\s+you\b|\bsend\s+(?:you\s+)?a\s+reminder\b/i,
  },
  {
    label: "promises a message on a later day",
    pattern:
      /\b(?:tomorrow|next week|next month|in a few days|in a couple of days|over the next few days|each (?:day|week)|every (?:day|week)|daily|weekly)\b/i,
  },
  {
    label: "implies a broadcast or a mailing list send over DM",
    pattern:
      /\bbroadcast\b|\bmass (?:dm|message)\b|\bblast\b|\bdm (?:everyone|my list|the list)\b|\beveryone on (?:my|the) list\b/i,
  },
  {
    label: "implies a drip or sequence of DMs",
    pattern: /\bdrip\b|\b(?:dm|message)\s+sequence\b|\bpart (?:one|two|1|2) of\b/i,
  },
  {
    label: "implies checkout or payment inside the DM thread",
    pattern:
      /\b(?:check\s?out|pay|buy|purchase|order)\s+(?:right\s+)?(?:here|in this (?:chat|dm|thread|message))\b|\bsend (?:me )?(?:your )?card\b/i,
  },
  {
    label: "asks the person to unsubscribe from DMs, which is not a thing",
    pattern: /\b(?:unsubscribe|opt out|reply stop)\b/i,
  },
];

/** Every blocked-capability rule `text` trips, by label. */
export function findBlockedCapabilityClaims(text: string): string[] {
  return BLOCKED_CAPABILITY_PATTERNS.filter((rule) =>
    rule.pattern.test(text)
  ).map((rule) => rule.label);
}
