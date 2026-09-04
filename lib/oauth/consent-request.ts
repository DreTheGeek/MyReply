import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { CONSENT_REQUEST_TTL_MS } from "@/lib/oauth/config";

/**
 * The authorization request, signed, so that what the user reads is exactly
 * what gets issued.
 *
 * The consent screen validates the request once and hands the form this blob.
 * When Approve comes back, the decision endpoint verifies the signature instead
 * of re-parsing query parameters, which means nothing between the two steps can
 * change the client, the redirect_uri, the scope or the resource after the user
 * has seen them.
 *
 * It is bound to the signed-in user and expires in ten minutes, so it doubles
 * as the CSRF token for the Approve and Deny buttons: another site cannot mint
 * one, and one minted for somebody else is refused.
 */

const payloadSchema = z.object({
  clientRecordId: z.string().min(1),
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  scope: z.string(),
  resource: z.string().min(1),
  state: z.string().nullable(),
  codeChallenge: z.string().min(1),
  codeChallengeMethod: z.literal("S256"),
  userId: z.string().min(1),
  exp: z.number(),
});

export type ConsentRequest = z.infer<typeof payloadSchema>;

function signingKey(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET environment variable is required");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function signConsentRequest(
  request: Omit<ConsentRequest, "exp">
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...request, exp: Date.now() + CONSENT_REQUEST_TTL_MS })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyConsentRequest(token: string | null): ConsentRequest | null {
  if (!token) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expected = sign(payload);
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const result = payloadSchema.safeParse(parsed);
  if (!result.success) return null;
  if (result.data.exp <= Date.now()) return null;

  return result.data;
}
