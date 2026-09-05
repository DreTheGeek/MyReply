import { stripSpecialCharacters } from "@/lib/utils/keyword-matcher";
import type { Goal } from "./types";

/**
 * Trigger word suggestions.
 *
 * The keyword field is the single worst blank in the product. The owner is
 * asked to guess what strangers will type, and most guess wrong or give up. So
 * we read the caption they already wrote, pull the words a commenter would
 * plausibly repeat, and top the list up with the words that work for the goal
 * they picked.
 *
 * Suggestions are uppercase because that is what people actually comment. The
 * matcher lowercases both sides anyway (lib/utils/keyword-matcher.ts), so the
 * casing here is purely so the chips read like a real comment.
 */

/** Never show more than this. Past six the list stops being a pick. */
export const MAX_KEYWORD_SUGGESTIONS = 6;

/** Never show fewer than this, even for an empty caption. */
export const MIN_KEYWORD_SUGGESTIONS = 3;

/** Caption-mined words shorter than this are noise, not triggers. */
const MIN_CAPTION_WORD_LENGTH = 3;

/**
 * Words we refuse to suggest, in two groups.
 *
 * 1. Grammar. Articles, pronouns, prepositions, conjunctions and auxiliary
 *    verbs. Every caption is full of them and no one comments "THE" on purpose.
 *
 * 2. Reaction noise. "love", "nice", "wow", "amazing", "fire", "goat" and the
 *    rest are the most common words on any Instagram post, which is exactly
 *    what makes them dangerous: a campaign keyed on LOVE fires on every person
 *    who liked the video and sends a sales DM to someone who asked for nothing.
 *    That is the fastest route to a spam report, and a spam report costs the
 *    account, not just the campaign.
 *
 * Deliberately absent: THANKS and APPRECIATE. They read like group two, but
 * they are the literal trigger of the `thanks` goal, where replying to praise
 * is the whole intent. Blocking them would mean the goal could never suggest
 * its own keywords.
 */
export const KEYWORD_BLOCKLIST: readonly string[] = [
  // Group one, grammar.
  "the", "and", "for", "you", "your", "yours", "our", "ours", "with", "that",
  "this", "these", "those", "are", "was", "were", "been", "being", "have",
  "has", "had", "not", "but", "all", "any", "can", "will", "would", "should",
  "could", "from", "into", "onto", "out", "off", "over", "under", "than",
  "then", "them", "they", "their", "there", "here", "what", "when", "where",
  "which", "while", "who", "whom", "why", "how", "get", "got", "just", "now",
  "one", "two", "own", "some", "such", "very", "too", "its", "his",
  "her", "him", "she", "hers", "about", "after", "again",
  "because", "before", "both", "each", "few", "more", "most", "other", "only",
  "same", "still", "also", "even", "ever", "every", "does", "did", "doing",
  "done", "make", "made", "take", "took", "come", "came", "want", "wants",
  "need", "needs", "know", "knows", "like", "likes", "liked", "say", "says",
  "see", "saw", "look", "looks", "way", "ways", "thing", "things", "let",
  "lets", "put", "day", "days", "new", "old", "big", "little", "good", "bad",
  "best", "better", "worse", "worst", "really", "much", "many", "lot", "lots",

  // Group two, reaction noise.
  "love", "loved", "loving", "nice", "wow", "cool", "amazing", "awesome",
  "beautiful", "gorgeous", "perfect", "great", "incredible", "insane",
  "obsessed", "fire", "goat", "queen", "king", "legend", "vibes", "mood",
  "iconic", "stunning", "cute", "pretty", "dope", "sick", "clean", "lol",
  "haha", "omg", "yep", "yeah", "nope", "hey", "hello", "please", "sorry",
  "congrats", "happy", "birthday", "welcome", "follow", "followed", "post",
  "posts", "video", "reel", "story", "content", "comment", "comments",
];

const BLOCKLIST_SET: ReadonlySet<string> = new Set(
  KEYWORD_BLOCKLIST.map((word) => word.toLowerCase())
);

export function isBlockedKeyword(word: string): boolean {
  return BLOCKLIST_SET.has(word.trim().toLowerCase());
}

/**
 * The words that already work for each goal, in the order we would offer them.
 *
 * These are curated, so the three-character floor that applies to caption
 * mining is deliberately not applied to them: "ME" is two characters and is one
 * of the highest-converting triggers there is, because it is what a person
 * types when they cannot be bothered to read the caption twice.
 */
export const GOAL_KEYWORDS: Readonly<Record<Goal, readonly string[]>> = {
  lead_magnet: ["GUIDE", "SEND", "LINK", "INFO", "ME"],
  price_question: ["PRICE", "COST", "QUOTE", "RATES", "INFO"],
  booking: ["BOOK", "CALL", "SLOT", "TIMES", "CONSULT"],
  waitlist: ["WAITLIST", "LIST", "EARLY", "NEXT", "ME"],
  faq: ["INFO", "DETAILS", "ANSWER", "HELP", "EXPLAIN"],
  thanks: ["THANKS", "APPRECIATE", "HELPED", "NEEDED", "YES"],
} as const;

/**
 * Last resort, used only if a goal's own list somehow runs dry. Keeps the
 * "always at least three" promise from depending on any one goal's list.
 */
const UNIVERSAL_FALLBACK_KEYWORDS: readonly string[] = ["INFO", "LINK", "YES", "ME"];

/**
 * Captions tell you the keyword outright more often than you would expect:
 * "comment GUIDE", "type PRICE below", "drop the word BOOK". Those get first
 * place, because the owner has already told their audience what to say.
 */
const CALL_TO_ACTION_PATTERN =
  /\b(?:comment|commenting|type|reply|drop|dm\s+me|send\s+me|say)\s+(?:the\s+word\s+)?['"]?([A-Za-z][A-Za-z0-9]{2,24})['"]?/gi;

/** Words written in shouting caps in the caption are usually the intended trigger. */
const SHOUTED_WORD_PATTERN = /\b([A-Z][A-Z0-9]{2,24})\b/g;

function stripNonKeywordNoise(caption: string): string {
  return caption
    // Links first, so a slug does not become six keyword candidates.
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    // Hashtags and mentions are discovery furniture, not things people comment.
    .replace(/[#@][\p{L}\p{N}_.]+/gu, " ");
}

function toCandidate(raw: string): string | null {
  const cleaned = stripSpecialCharacters(raw).trim().toUpperCase();
  if (!cleaned || cleaned.includes(" ")) return null;
  // Letters and digits only, and it has to contain at least one letter so a
  // year or a price never becomes a trigger word.
  if (!/^[A-Z0-9]+$/.test(cleaned)) return null;
  if (!/[A-Z]/.test(cleaned)) return null;
  if (cleaned.length < MIN_CAPTION_WORD_LENGTH) return null;
  if (isBlockedKeyword(cleaned)) return null;
  return cleaned;
}

function mineCaption(caption: string): {
  calledOut: string[];
  shouted: string[];
  ordinary: string[];
} {
  const cleaned = stripNonKeywordNoise(caption);

  const calledOut: string[] = [];
  for (const match of cleaned.matchAll(CALL_TO_ACTION_PATTERN)) {
    const candidate = toCandidate(match[1] ?? "");
    if (candidate) calledOut.push(candidate);
  }

  const shouted: string[] = [];
  for (const match of cleaned.matchAll(SHOUTED_WORD_PATTERN)) {
    const candidate = toCandidate(match[1] ?? "");
    if (candidate) shouted.push(candidate);
  }

  const ordinary: string[] = [];
  for (const word of stripSpecialCharacters(cleaned).split(/\s+/)) {
    const candidate = toCandidate(word);
    if (candidate) ordinary.push(candidate);
  }

  return { calledOut, shouted, ordinary };
}

/**
 * Suggest trigger words for a post.
 *
 * Order of preference:
 * 1. Words the caption explicitly asks for ("comment GUIDE").
 * 2. Words the caption shouts in caps.
 * 3. The first two goal defaults, so a wordy caption can never crowd out the
 *    words that are known to work.
 * 4. Everything else worth having from the caption.
 * 5. The rest of the goal defaults, then the universal fallback.
 *
 * Always returns between MIN_KEYWORD_SUGGESTIONS and MAX_KEYWORD_SUGGESTIONS
 * entries, uppercase, deduplicated case-insensitively, and never a blocklisted
 * word. A null or empty caption is normal, not an error: it is what the owner
 * sees before they have picked a post.
 */
export function suggestKeywords(caption: string | null, goal: Goal): string[] {
  const goalDefaults = GOAL_KEYWORDS[goal] ?? UNIVERSAL_FALLBACK_KEYWORDS;
  const { calledOut, shouted, ordinary } = caption ? mineCaption(caption) : {
    calledOut: [],
    shouted: [],
    ordinary: [],
  };

  const ordered: string[] = [
    ...calledOut,
    ...shouted,
    ...goalDefaults.slice(0, 2),
    ...ordinary,
    ...goalDefaults,
    ...UNIVERSAL_FALLBACK_KEYWORDS,
  ];

  const seen = new Set<string>();
  const picked: string[] = [];

  for (const word of ordered) {
    const normalized = word.trim().toUpperCase();
    if (!normalized) continue;
    // Curated lists skip the length floor but never the blocklist.
    if (isBlockedKeyword(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    picked.push(normalized);
    if (picked.length >= MAX_KEYWORD_SUGGESTIONS) break;
  }

  return picked;
}
