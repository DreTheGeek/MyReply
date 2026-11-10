import { randomBytes } from "crypto";
import type { ApiKeyContext } from "@/lib/api-keys";
import { hashApiKey } from "@/lib/api-keys";
import { PARTNER_SCOPES, effectiveScopes, type ApiScope } from "@/lib/api/scopes";
import { prisma } from "@/lib/db/client";

/**
 * Partner keys: mr_partner_<43 chars of base64url>.
 *
 * The same discipline as workspace keys. Only the SHA-256 is stored, lookup is
 * by that hash, and the plaintext exists once, in the hands of whoever minted
 * it. A partner key on its own reaches only the partner's own endpoints
 * (making and listing workspaces). To act inside a workspace it must also name
 * the workspace, and only one the partner created is ever accepted.
 */

export const PARTNER_KEY_PREFIX = "mr_partner_";
const PREFIX_DISPLAY_LENGTH = PARTNER_KEY_PREFIX.length + 6;

/** The header a partner key names its workspace in. */
export const WORKSPACE_HEADER = "x-workspace-id";

export interface GeneratedPartnerKey {
  plaintext: string;
  prefix: string;
  hashedKey: string;
}

export function generatePartnerKey(): GeneratedPartnerKey {
  const plaintext = PARTNER_KEY_PREFIX + randomBytes(32).toString("base64url");
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_DISPLAY_LENGTH),
    hashedKey: hashApiKey(plaintext),
  };
}

export function isPartnerKey(token: string): boolean {
  return token.startsWith(PARTNER_KEY_PREFIX);
}

/** A partner key out of an Authorization header, or null. */
export function extractPartnerKey(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const token = match[1].trim();
  return isPartnerKey(token) ? token : null;
}

export interface PartnerCaller {
  partnerId: string;
  keyId: string;
  scopes: ApiScope[];
  /** Rate limit identity for the partner's own endpoints. Never the secret. */
  credentialId: string;
}

/**
 * Resolve a partner key, refusing a revoked or expired key and any key of a
 * disabled partner. Null, never a throw, so a bad key is a 401 and not a 500.
 */
export async function resolvePartnerKey(plaintext: string): Promise<PartnerCaller | null> {
  const record = await prisma.partnerApiKey.findUnique({
    where: { hashedKey: hashApiKey(plaintext) },
    select: {
      id: true,
      partnerId: true,
      scopes: true,
      revokedAt: true,
      expiresAt: true,
      partner: { select: { disabledAt: true } },
    },
  });

  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt && record.expiresAt <= new Date()) return null;
  if (record.partner.disabledAt) return null;

  return {
    partnerId: record.partnerId,
    keyId: record.id,
    scopes: effectiveScopes(record.scopes ?? [], PARTNER_SCOPES),
    credentialId: `partner:${record.id}`,
  };
}

/**
 * A partner key acting inside one workspace, or null when the workspace is not
 * the partner's. Unknown and someone else's answer the same, so a partner
 * cannot learn which ids exist.
 */
export async function partnerWorkspaceContext(
  partner: PartnerCaller,
  workspaceId: string
): Promise<ApiKeyContext | null> {
  if (!workspaceId || workspaceId.length > 100) return null;

  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, partnerId: partner.partnerId },
    select: { id: true },
  });
  if (!workspace) return null;

  return {
    workspaceId: workspace.id,
    // The partner made the workspace and stands in for its owner. Owner-only
    // actions (billing, deleting the workspace from the dashboard) stay out of
    // reach because keys stop at admin.
    role: "ADMIN",
    apiKeyId: partner.keyId,
    kind: "partner",
    partnerId: partner.partnerId,
    scopes: partner.scopes,
    // Counted per workspace, so one busy studio cannot use up every other
    // studio's allowance under the same key.
    credentialId: `partner:${partner.keyId}:${workspace.id}`,
  };
}

/** Best-effort usage stamp, never awaited on the hot path. */
export function touchPartnerKey(keyId: string): void {
  void prisma.partnerApiKey
    .update({ where: { id: keyId }, data: { lastUsedAt: new Date() } })
    .catch((error: unknown) => {
      console.error(
        "[partners] Could not stamp key use:",
        error instanceof Error ? error.name : "unknown"
      );
    });
}
