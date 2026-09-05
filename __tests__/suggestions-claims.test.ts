import { describe, expect, it } from "vitest";
import { DM_MESSAGES, PUBLIC_REPLY_MESSAGES } from "../lib/suggestions/messages";

/**
 * These messages go out under the customer's name, to their real audience, from
 * a library that knows nothing about what they sell. A default that asserts a
 * price, a duration or a promise is a lie for most of the people sending it.
 *
 * Three shipped in the first version: a thirty minute session, a free download
 * with no email wall, and a ten minute read with a checklist at the end. This
 * test exists so the fourth does not.
 */
const INVENTED_CLAIMS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(thirty|fifteen|twenty|ten|five)\s+minutes?\b/i, why: "a duration we cannot know" },
  { pattern: /\bfree\b/i, why: "we do not know their pricing" },
  { pattern: /\bno email wall\b/i, why: "we do not know how they gate it" },
  { pattern: /\b(refund|money back|guarantee)\b/i, why: "a promise we cannot make for them" },
  { pattern: /\b\d+\s*%\s*off\b/i, why: "a discount we invented" },
  { pattern: /\b(next business day|within 24 hours|same day)\b/i, why: "a turnaround we cannot know" },
  { pattern: /\bship(s|ping)?\b/i, why: "not every business ships anything" },
];

function everyMessage(): string[] {
  const out: string[] = [];
  for (const byTone of Object.values(DM_MESSAGES)) {
    for (const messages of Object.values(byTone)) out.push(...messages);
  }
  for (const replies of Object.values(PUBLIC_REPLY_MESSAGES)) out.push(...replies);
  return out;
}

describe("no message invents a fact about the customer's business", () => {
  for (const { pattern, why } of INVENTED_CLAIMS) {
    it(`never claims ${pattern.source}, because that is ${why}`, () => {
      const offenders = everyMessage().filter((message) => pattern.test(message));
      expect(offenders).toEqual([]);
    });
  }

  it("still has real copy to check, so a passing run means something", () => {
    expect(everyMessage().length).toBeGreaterThan(100);
  });
});
