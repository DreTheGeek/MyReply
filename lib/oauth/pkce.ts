import { createHash } from "crypto";
import { secureEquals } from "@/lib/oauth/secrets";

/**
 * PKCE, RFC 7636, S256 only.
 *
 * OAuth 2.1 requires PKCE on every authorization code flow, and `plain` is not
 * offered: it protects nothing against an attacker who can already see the
 * authorization request. A client sending `plain` is refused at the
 * authorization endpoint rather than silently downgraded.
 */

export const CODE_CHALLENGE_METHOD = "S256";

/** RFC 7636: 43 to 128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** A challenge is base64url of a SHA-256 digest, so 43 characters exactly. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE_PATTERN.test(challenge);
}

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

/** The challenge a given verifier produces. Exported so tests can build one. */
export function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyCodeVerifier(
  verifier: string,
  challenge: string,
  method: string
): boolean {
  if (method !== CODE_CHALLENGE_METHOD) return false;
  if (!isValidCodeVerifier(verifier)) return false;
  return secureEquals(deriveCodeChallenge(verifier), challenge);
}
