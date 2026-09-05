import type { Tone } from "./types";
import { DEFAULT_TONE, TONE_IDS, isTone, toneSchema } from "./types";

/**
 * Tone, the one-time workspace decision.
 *
 * The owner picks a voice once and every suggested message inherits it. This
 * file is the seam between the two spellings of that choice: the database
 * stores a Prisma enum in SCREAMING_CASE, the UI and the message library use
 * lowercase ids. Nothing else in the codebase should do that conversion by
 * hand.
 *
 * Pure on purpose. The database read lives in lib/suggestions/workspace-tone.ts
 * so that a client component can import from here without pulling Prisma in.
 */

/**
 * The stored spelling. Mirrors `enum WorkspaceTone` in prisma/schema.prisma.
 * workspace-tone.ts asserts at compile time that these match the generated
 * client, so adding a value in one place and not the other breaks the build
 * rather than a DM.
 */
export const WORKSPACE_TONE_VALUES = [
  "FRIENDLY",
  "PROFESSIONAL",
  "HYPE",
  "SHORT",
  "WARM",
] as const;

export type WorkspaceToneValue = (typeof WORKSPACE_TONE_VALUES)[number];

const TO_DB: Readonly<Record<Tone, WorkspaceToneValue>> = {
  friendly: "FRIENDLY",
  professional: "PROFESSIONAL",
  hype: "HYPE",
  short: "SHORT",
  warm: "WARM",
};

const FROM_DB: Readonly<Record<WorkspaceToneValue, Tone>> = {
  FRIENDLY: "friendly",
  PROFESSIONAL: "professional",
  HYPE: "hype",
  SHORT: "short",
  WARM: "warm",
};

/** The lowercase id for a stored enum value. */
export function toneToWorkspaceTone(tone: Tone): WorkspaceToneValue {
  return TO_DB[tone] ?? "FRIENDLY";
}

/**
 * Narrow anything at all to a tone id. A row written before the column
 * existed, a query string, a stale client payload: none of them are a reason to
 * show a blank, so unknown input resolves to the default rather than throwing.
 */
export function resolveTone(value: unknown): Tone {
  if (isTone(value)) return value;
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    const known = (WORKSPACE_TONE_VALUES as readonly string[]).includes(upper)
      ? FROM_DB[upper as WorkspaceToneValue]
      : undefined;
    if (known) return known;
  }
  return DEFAULT_TONE;
}

/**
 * Read the tone off a workspace row. Takes the row rather than an id so a
 * caller that already loaded the workspace does not pay for a second query.
 */
export function getWorkspaceTone(
  workspace: { tone?: unknown } | null | undefined
): Tone {
  return resolveTone(workspace?.tone);
}

export { DEFAULT_TONE, TONE_IDS, isTone, toneSchema };
export type { Tone };
