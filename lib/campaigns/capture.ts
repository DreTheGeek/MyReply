/**
 * The capture step: a campaign asking for an email or phone number.
 *
 * After the campaign's message, the engine can send one more: a short ask, the
 * consent wording, and the platform's one-tap buttons that fill in the
 * person's own email or phone number. Nothing is typed, so nothing is guessed.
 *
 * Consent is the tap. A direct message has no checkbox, so the wording sits
 * directly above the buttons and the tap that follows it is the person's
 * agreement. Every ask is stored with that wording exactly as shown, and a tap
 * is only recorded against a stored ask, so a detail never exists without the
 * words the person saw and the time they chose to share it.
 */

import { z } from "zod";

export const CAPTURE_KINDS = ["email", "phone"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** Short enough to read above the buttons; Instagram allows 1000. */
export const MAX_CAPTURE_TEXT = 500;

/** How long after an ask a tap still counts as an answer to it. */
export const CAPTURE_ANSWER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long an ask is kept once nobody can answer it any more. */
export const CAPTURE_PROMPT_RETENTION_DAYS = 30;

export const DEFAULT_CAPTURE_PROMPT: Record<"email" | "phone" | "both", string> = {
  email: "Want updates by email? Tap below to share yours.",
  phone: "Want a text when there's news? Tap below to share your number.",
  both: "Want to hear from us outside of DMs? Tap below to share your email or number.",
};

export const DEFAULT_CAPTURE_CONSENT =
  "By tapping, you agree we can contact you about this. You can ask us to stop at any time.";

/** Stored campaign settings, as the builder and API send them. */
export const captureSettingsSchema = z.object({
  captureEnabled: z.boolean(),
  captureKinds: z.array(z.enum(CAPTURE_KINDS)).max(CAPTURE_KINDS.length),
  capturePrompt: z.string().trim().max(MAX_CAPTURE_TEXT).nullable(),
  captureConsentText: z.string().trim().max(MAX_CAPTURE_TEXT).nullable(),
});

export interface CaptureSettings {
  captureEnabled?: boolean | null;
  captureKinds?: string[] | null;
  capturePrompt?: string | null;
  captureConsentText?: string | null;
}

/** What the engine sends for one ask, ready to hand to an adapter. */
export interface CaptureAsk {
  kinds: CaptureKind[];
  /** The ask and the consent wording, as one message. */
  text: string;
  /** The consent wording alone, stored with the ask. */
  consentText: string;
}

/** The kinds a campaign asks for, deduplicated, in a stable order. */
export function captureKinds(raw: readonly string[] | null | undefined): CaptureKind[] {
  const wanted = new Set(raw ?? []);
  return CAPTURE_KINDS.filter((kind) => wanted.has(kind));
}

/**
 * The ask a campaign sends, or null when it asks for nothing.
 *
 * Blank wording falls back to the defaults, so a campaign saved before the
 * owner wrote their own still shows consent wording rather than bare buttons.
 * `supported` is what the platform can prefill: a kind it cannot is dropped
 * rather than sent as a button that does nothing.
 */
export function buildCaptureAsk(
  settings: CaptureSettings,
  supported: { email: boolean; phone: boolean }
): CaptureAsk | null {
  if (!settings.captureEnabled) return null;
  const kinds = captureKinds(settings.captureKinds).filter((kind) => supported[kind]);
  if (kinds.length === 0) return null;

  const fallbackPrompt =
    kinds.length === 2 ? DEFAULT_CAPTURE_PROMPT.both : DEFAULT_CAPTURE_PROMPT[kinds[0]];
  const prompt = settings.capturePrompt?.trim() || fallbackPrompt;
  const consentText = settings.captureConsentText?.trim() || DEFAULT_CAPTURE_CONSENT;

  return { kinds, text: `${prompt}\n\n${consentText}`, consentText };
}

const emailSchema = z.email().max(254);

/**
 * A phone number as the platform fills it in: digits, an optional leading
 * plus, and the usual separators. Stored as the plus and digits only.
 */
const PHONE_PATTERN = /^\+?[0-9][0-9 ().-]{5,24}$/;

export interface CapturedDetail {
  kind: CaptureKind;
  value: string;
}

/**
 * Read a tapped quick reply as an email or phone number.
 *
 * The platform puts the person's own detail in the tap's payload. It is still
 * input from outside, so it is validated and normalised here, and anything
 * that is neither comes back null and is never stored.
 */
export function parseCapturedDetail(payload: unknown): CapturedDetail | null {
  if (typeof payload !== "string") return null;
  const value = payload.trim();
  if (value.length === 0 || value.length > 254) return null;

  const email = emailSchema.safeParse(value);
  if (email.success) return { kind: "email", value: email.data.toLowerCase() };

  if (PHONE_PATTERN.test(value)) {
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      return { kind: "phone", value: `${value.startsWith("+") ? "+" : ""}${digits}` };
    }
  }
  return null;
}

/** The database enum for a kind. */
export function detailKindEnum(kind: CaptureKind): "EMAIL" | "PHONE" {
  return kind === "email" ? "EMAIL" : "PHONE";
}
