import { z } from "zod";

const HEX_32_BYTE = /^[a-f0-9]{64}$/i;

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export function requireEnv(name: string): string {
  return readEnv(name);
}

export function getBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

export function getEncryptionKeyHex(): string {
  const value = readEnv("ENCRYPTION_KEY");
  if (!HEX_32_BYTE.test(value)) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex string");
  }
  return value;
}

// Env vars that must be present before an Instagram OAuth round trip can even
// start. Checked up front so a self-hoster with a half-filled .env gets the
// variable names back instead of an unhandled throw from requireEnv().
const INSTAGRAM_OAUTH_ENV = [
  "INSTAGRAM_APP_ID",
  "INSTAGRAM_APP_SECRET",
  "ENCRYPTION_KEY",
  "NEXTAUTH_SECRET",
] as const;

export function getMissingInstagramOAuthEnv(): string[] {
  return INSTAGRAM_OAUTH_ENV.filter((name) => {
    const value = process.env[name];
    if (!value) return true;
    // A malformed key fails later inside encryptToken, after the user has
    // already round-tripped through Meta — catch the bad format here instead.
    return name === "ENCRYPTION_KEY" && !HEX_32_BYTE.test(value);
  });
}

export function getMetaGraphApiVersion(): string {
  return process.env.META_GRAPH_API_VERSION ?? "v25.0";
}

export const serverEnvSchema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(HEX_32_BYTE),
  INSTAGRAM_APP_ID: z.string().min(1),
  INSTAGRAM_APP_SECRET: z.string().min(1),
  FACEBOOK_APP_SECRET: z.string().min(1),
  WEBHOOK_VERIFY_TOKEN: z.string().min(1),
});

export function validateCoreEnv() {
  return serverEnvSchema.parse(process.env);
}

/**
 * What the WORKER needs, which is not what the web app needs.
 *
 * Validating the web contract inside the worker took production down: the
 * worker has no WEBHOOK_VERIFY_TOKEN because it never serves Meta's
 * verification handshake, so a check meant to catch misconfiguration became
 * the misconfiguration. A process should only be held to the variables it
 * actually reads.
 *
 * What is in here and why:
 *   DATABASE_URL    every job reads and writes.
 *   REDIS_URL       BullMQ, and an unset value silently targets localhost.
 *   ENCRYPTION_KEY  decryptToken, on every send.
 *   NEXTAUTH_URL    buildTrackedUrl falls back to http://localhost:3000 when
 *                   this is missing, so the worker would send real customers a
 *                   link to a machine that is not on the internet. Silent, and
 *                   only visible as clicks that never arrive.
 *
 * What is deliberately absent: NEXTAUTH_SECRET (no sessions here),
 * INSTAGRAM_APP_ID and the two app secrets (OAuth and webhook signature
 * verification are the web app's job), WEBHOOK_VERIFY_TOKEN (same).
 */
export const workerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(HEX_32_BYTE),
  NEXTAUTH_URL: z.string().url(),
});

export function validateWorkerEnv() {
  return workerEnvSchema.parse(process.env);
}
