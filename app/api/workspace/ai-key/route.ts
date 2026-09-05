import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AI_PROVIDERS,
  MAX_KEY_LENGTH,
  MAX_MODEL_LENGTH,
  MIN_KEY_LENGTH,
  getProviderSpec,
} from "@/lib/ai/providers";
import { validateProviderKey } from "@/lib/ai/client";
import {
  deleteWorkspaceAiKey,
  getWorkspaceAiKeyStatus,
  saveWorkspaceAiKey,
} from "@/lib/ai/workspace-key";
import { recordAuditEvent } from "@/lib/audit";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The workspace's own AI provider key.
 *
 * MyReply is bring your own key, so this is the credential Ask MyReply runs on.
 * The plaintext key crosses this route exactly once, on the way in. Nothing on
 * any method returns it, and there is no endpoint that can: the only readable
 * form after a save is the masked hint.
 */

const saveSchema = z.object({
  provider: z.enum(["ANTHROPIC", "OPENROUTER"]),
  apiKey: z.string().trim().min(MIN_KEY_LENGTH).max(MAX_KEY_LENGTH),
  model: z.string().trim().max(MAX_MODEL_LENGTH).optional(),
});

/** The provider list the settings UI renders. No secrets, safe for a MEMBER. */
const PROVIDER_OPTIONS = AI_PROVIDERS.map((provider) => ({
  id: provider.id,
  label: provider.label,
  defaultModel: provider.defaultModel,
  consoleUrl: provider.consoleUrl,
  keyPlaceholder: provider.keyPlaceholder,
}));

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Status is readable by every member: knowing whether a key exists is what
  // tells a MEMBER why the assistant is refusing to answer.
  const status = await getWorkspaceAiKeyStatus(context.workspaceId);

  return NextResponse.json({
    success: true,
    data: {
      ...status,
      canManage: canManageWorkspace(context.role),
      providers: PROVIDER_OPTIONS,
    },
  });
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only workspace owners and admins can change the AI key.",
      },
      { status: 403 }
    );
  }

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Choose a provider and paste a valid key." },
      { status: 400 }
    );
  }

  const { provider, apiKey } = parsed.data;
  const model = parsed.data.model || getProviderSpec(provider).defaultModel;

  // One cheap authenticated call before anything is written. A key that does
  // not work is worse than no key at all: the assistant would look broken
  // rather than unconfigured, and the owner would have no idea why.
  const validation = await validateProviderKey(provider, model, apiKey);
  if (!validation.ok) {
    return NextResponse.json(
      {
        success: false,
        error:
          validation.error ??
          "The provider rejected that key. Check it and try again.",
      },
      { status: 400 }
    );
  }

  const status = await saveWorkspaceAiKey({
    workspaceId: context.workspaceId,
    provider,
    apiKey,
    model,
    // Empty when the caller was an API key, which has no user behind it.
    createdByUserId: context.userId || null,
  });

  // Status only. The key the caller just sent is not echoed back.
  return NextResponse.json({
    success: true,
    data: { ...status, canManage: true, providers: PROVIDER_OPTIONS },
  });
}

export async function DELETE() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only workspace owners and admins can remove the AI key.",
      },
      { status: 403 }
    );
  }

  const removed = await deleteWorkspaceAiKey(context.workspaceId);
  if (!removed) {
    return NextResponse.json(
      { success: false, error: "No AI key is configured." },
      { status: 404 }
    );
  }

  await recordAuditEvent({
    workspaceId: context.workspaceId,
    action: "ai_credential.deleted",
    actorUserId: context.userId,
  });

  return NextResponse.json({
    success: true,
    data: {
      configured: false,
      provider: null,
      model: null,
      keyHint: null,
      updatedAt: null,
      lastUsedAt: null,
      canManage: true,
      providers: PROVIDER_OPTIONS,
    },
  });
}
