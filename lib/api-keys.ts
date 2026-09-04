import { createHash, randomBytes } from "crypto";
import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * API key format: mr_live_<43 chars of base64url>.
 *
 * The prefix is stored in the clear so the dashboard can label a key without
 * being able to reconstruct it. Only the SHA-256 of the whole key is stored,
 * and lookup is by that hash, so there is no string comparison to time and a
 * dumped database row cannot be replayed.
 */
const KEY_PREFIX = "mr_live_";
const PREFIX_DISPLAY_LENGTH = KEY_PREFIX.length + 6;

export interface GeneratedApiKey {
  /** Shown to the caller exactly once, never persisted. */
  plaintext: string;
  prefix: string;
  hashedKey: string;
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = KEY_PREFIX + randomBytes(32).toString("base64url");
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_DISPLAY_LENGTH),
    hashedKey: hashApiKey(plaintext),
  };
}

/**
 * Pull a bearer token out of an Authorization header, if it looks like one of
 * ours. Returns null for a session request or an unrelated bearer, so the
 * caller falls through to cookie auth rather than erroring.
 */
export function extractApiKey(authorization: string | null): string | null {
  if (!authorization) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;

  const token = match[1].trim();
  return token.startsWith(KEY_PREFIX) ? token : null;
}

export interface ApiKeyContext {
  workspaceId: string;
  role: WorkspaceRole;
  apiKeyId: string;
}

/**
 * Resolve a plaintext key to its workspace, rejecting revoked and expired keys.
 * Returns null rather than throwing so an invalid key degrades to unauthorized
 * instead of a 500.
 */
export async function resolveApiKey(
  plaintext: string
): Promise<ApiKeyContext | null> {
  const record = await prisma.apiKey.findUnique({
    where: { hashedKey: hashApiKey(plaintext) },
    select: {
      id: true,
      workspaceId: true,
      role: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt && record.expiresAt <= new Date()) return null;

  return {
    workspaceId: record.workspaceId,
    role: record.role,
    apiKeyId: record.id,
  };
}

/**
 * Best-effort usage stamp. Deliberately not awaited by callers on the hot path,
 * and deliberately swallowing errors: a failed bookkeeping write must never
 * turn a valid request into a failed one.
 */
export function touchApiKey(apiKeyId: string): void {
  void prisma.apiKey
    .update({
      where: { id: apiKeyId },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});
}
