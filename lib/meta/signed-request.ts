import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

/**
 * Meta's signed_request, as posted to the deauthorize and data deletion
 * callbacks.
 *
 * The value is `<signature>.<payload>`, both base64url. The signature is an
 * HMAC-SHA256 of the payload segment, keyed with the app secret of the app
 * the person removed. Facebook Login and Instagram business login are
 * separate apps with separate secrets, so the caller says which one applies.
 *
 * Returns null for anything that does not verify: a missing value, the wrong
 * algorithm, a bad signature or a payload without a user id. A forged request
 * must never reach the code that pauses or deletes accounts.
 */

const payloadSchema = z.object({
  algorithm: z.string(),
  user_id: z.union([z.string().min(1), z.number()]).transform(String),
  issued_at: z.number().optional(),
});

export interface SignedRequestPayload {
  /** The app-scoped id of the person who removed the app. */
  userId: string;
  issuedAt: Date | null;
}

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function parseSignedRequest(
  signedRequest: unknown,
  appSecret: string | undefined
): SignedRequestPayload | null {
  if (typeof signedRequest !== "string" || !appSecret) return null;
  // A real one is a few hundred bytes. Anything far larger is not one.
  if (signedRequest.length > 4096) return null;

  const parts = signedRequest.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [encodedSignature, encodedPayload] = parts;

  const signature = base64UrlDecode(encodedSignature);
  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  } catch {
    // Signed by Meta yet unreadable: refuse it rather than guess at its user.
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success || parsed.data.algorithm.toUpperCase() !== "HMAC-SHA256") return null;

  return {
    userId: parsed.data.user_id,
    issuedAt:
      typeof parsed.data.issued_at === "number" ? new Date(parsed.data.issued_at * 1000) : null,
  };
}
