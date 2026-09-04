import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * Every bearer-shaped string this server issues, generated and hashed in one
 * place.
 *
 * The discipline is the one lib/api-keys.ts already uses: 32 random bytes
 * behind a readable prefix, only the SHA-256 stored, and lookup by that hash so
 * there is no comparison to time and a dumped row cannot be replayed. Nothing
 * here ever returns a plaintext value except to the caller who is about to hand
 * it to its owner.
 */

const SECRET_BYTES = 32;

export const AUTHORIZATION_CODE_PREFIX = "mr_code_";
export const ACCESS_TOKEN_PREFIX = "mr_at_";
export const REFRESH_TOKEN_PREFIX = "mr_rt_";

/** The API key prefix, which the MCP route must keep accepting. */
export const API_KEY_PREFIX = "mr_live_";

export interface GeneratedSecret {
  /** Handed to its owner once. Never persisted. */
  plaintext: string;
  hashed: string;
}

export function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateSecret(prefix: string): GeneratedSecret {
  const plaintext = prefix + randomBytes(SECRET_BYTES).toString("base64url");
  return { plaintext, hashed: hashSecret(plaintext) };
}

/**
 * The token out of an Authorization header, whatever kind it is.
 *
 * Unlike extractApiKey this does not filter by prefix: the MCP route needs to
 * see an OAuth access token as well as an API key, and decides between them
 * itself.
 */
export function extractBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/** Constant-time string comparison that does not leak length through timing. */
export function secureEquals(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
