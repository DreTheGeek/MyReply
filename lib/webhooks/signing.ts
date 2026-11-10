import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Signing in the Standard Webhooks format (standardwebhooks.com), so a partner
 * can verify with any of that project's libraries instead of writing its own:
 *
 *   webhook-id:        the event id
 *   webhook-timestamp: seconds since the epoch
 *   webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">
 *
 * The secret is whsec_ followed by base64 of 24 random bytes; the HMAC key is
 * those decoded bytes. A receiver should refuse a timestamp more than five
 * minutes from its own clock, which is what stops a captured delivery being
 * replayed later.
 */

export const SECRET_PREFIX = "whsec_";

export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString("base64");
}

function keyBytes(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error("Not a webhook secret");
  return Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
}

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const signature = createHmac("sha256", keyBytes(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${signature}`;
}

export function webhookHeaders(
  secret: string,
  id: string,
  timestamp: number,
  body: string
): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "Webhooks/1.0",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signWebhook(secret, id, timestamp, body),
  };
}

/**
 * The receiver's side, for tests and for anyone porting it: true when one of
 * the signatures in the header matches and the timestamp is within tolerance.
 */
export function verifyWebhook(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300
): boolean {
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, headers.id, timestamp, body));
  return headers.signature.split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
