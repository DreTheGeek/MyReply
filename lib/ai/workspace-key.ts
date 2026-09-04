/**
 * Storage for a workspace's AI provider key.
 *
 * Follows the same shape as lib/api-keys.ts: a credential the UI can name but
 * can never read back. The difference is that we have to be able to send this
 * one upstream, so it is encrypted rather than hashed, using the existing
 * AES-256-GCM helpers and the existing ENCRYPTION_KEY. There is deliberately no
 * second crypto scheme in this codebase.
 *
 * getWorkspaceAiKeyStatus is what routes return. getWorkspaceAiCredential is
 * the only function that decrypts, and its result must never leave the server.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import {
  type AiProviderId,
  getProviderSpec,
  maskProviderKey,
} from "@/lib/ai/providers";

/** Safe to serialise. Contains no part of the key beyond the masked hint. */
export interface WorkspaceAiKeyStatus {
  configured: boolean;
  provider: AiProviderId | null;
  model: string | null;
  keyHint: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
}

/** Server only. Holds plaintext. Never put this in a response body. */
export interface WorkspaceAiCredential {
  provider: AiProviderId;
  model: string;
  apiKey: string;
}

export const UNCONFIGURED_STATUS: WorkspaceAiKeyStatus = {
  configured: false,
  provider: null,
  model: null,
  keyHint: null,
  updatedAt: null,
  lastUsedAt: null,
};

export async function getWorkspaceAiKeyStatus(
  workspaceId: string
): Promise<WorkspaceAiKeyStatus> {
  const record = await prisma.workspaceAiCredential.findUnique({
    where: { workspaceId },
    select: {
      provider: true,
      model: true,
      keyHint: true,
      updatedAt: true,
      lastUsedAt: true,
    },
  });

  if (!record) return UNCONFIGURED_STATUS;

  return {
    configured: true,
    provider: record.provider,
    model: record.model,
    keyHint: record.keyHint,
    updatedAt: record.updatedAt.toISOString(),
    lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
  };
}

/**
 * Decrypt the workspace's key for one model call. Returns null when the
 * workspace has not configured one, which the assistant turns into a structured
 * refusal rather than an error.
 */
export async function getWorkspaceAiCredential(
  workspaceId: string
): Promise<WorkspaceAiCredential | null> {
  const record = await prisma.workspaceAiCredential.findUnique({
    where: { workspaceId },
    select: { provider: true, model: true, encryptedKey: true },
  });

  if (!record) return null;

  return {
    provider: record.provider,
    model: record.model,
    apiKey: decryptToken(record.encryptedKey),
  };
}

export interface SaveWorkspaceAiKeyInput {
  workspaceId: string;
  provider: AiProviderId;
  apiKey: string;
  /** Blank falls back to the provider's default model. */
  model?: string;
  createdByUserId?: string | null;
}

/**
 * Replace whatever the workspace had. One credential per workspace, so this is
 * an upsert rather than an append: there is no version history to keep and a
 * second row would only be a second thing to leak.
 */
export async function saveWorkspaceAiKey(
  input: SaveWorkspaceAiKeyInput
): Promise<WorkspaceAiKeyStatus> {
  const apiKey = input.apiKey.trim();
  const model =
    input.model?.trim() || getProviderSpec(input.provider).defaultModel;

  const data = {
    provider: input.provider,
    encryptedKey: encryptToken(apiKey),
    keyHint: maskProviderKey(apiKey),
    model,
    createdByUserId: input.createdByUserId || null,
    // A new key has never been used, whatever the old one had done.
    lastUsedAt: null,
  };

  const record = await prisma.workspaceAiCredential.upsert({
    where: { workspaceId: input.workspaceId },
    create: { workspaceId: input.workspaceId, ...data },
    update: data,
    select: {
      provider: true,
      model: true,
      keyHint: true,
      updatedAt: true,
      lastUsedAt: true,
    },
  });

  return {
    configured: true,
    provider: record.provider,
    model: record.model,
    keyHint: record.keyHint,
    updatedAt: record.updatedAt.toISOString(),
    lastUsedAt: null,
  };
}

/** Returns false when there was nothing to delete, so the route can 404. */
export async function deleteWorkspaceAiKey(
  workspaceId: string
): Promise<boolean> {
  const result = await prisma.workspaceAiCredential.deleteMany({
    where: { workspaceId },
  });
  return result.count > 0;
}

/**
 * Best-effort usage stamp, mirroring touchApiKey: bookkeeping must never turn a
 * good answer into a failed request.
 */
export function touchWorkspaceAiKey(workspaceId: string): void {
  void prisma.workspaceAiCredential
    .updateMany({ where: { workspaceId }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
}
