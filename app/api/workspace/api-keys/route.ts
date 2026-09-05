import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { recordAuditEvent } from "@/lib/audit";
import { generateApiKey } from "@/lib/api-keys";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
  hasWorkspaceRole,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(["MEMBER", "ADMIN"]).default("ADMIN"),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

const revokeSchema = z.object({
  id: z.string().min(1),
});

/**
 * List this workspace's keys. Never returns a key or its hash, only metadata.
 *
 * Open to any member, matching /api/workspace/members: a member can see that
 * keys exist and when they were last used, but the write verbs below stay
 * gated on canManageWorkspace.
 */
export async function GET(): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const keys = await prisma.apiKey.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      prefix: true,
      role: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    success: true,
    data: { keys, currentUserRole: context.role },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "A name is required, and any expiry must be a number of days",
      },
      { status: 400 }
    );
  }

  // A key can never act with more access than the person minting it. The gate
  // above already requires ADMIN, so today this only bites if that gate is ever
  // loosened. That is precisely when a silent escalation would do the damage,
  // so the ceiling is checked here rather than left implied.
  if (!hasWorkspaceRole(context.role, parsed.data.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "A key cannot be given more access than your own role",
      },
      { status: 403 }
    );
  }

  const { plaintext, prefix, hashedKey } = generateApiKey();
  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
    : null;

  const key = await prisma.apiKey.create({
    data: {
      workspaceId: context.workspaceId,
      name: parsed.data.name,
      prefix,
      hashedKey,
      role: parsed.data.role,
      expiresAt,
      // Empty when the caller was itself an API key, which has no user behind it.
      createdByUserId: context.userId || null,
    },
    select: {
      id: true,
      name: true,
      prefix: true,
      role: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  // The only time the plaintext key exists outside the caller's hands. It is
  // not stored and cannot be shown again.
  return NextResponse.json({
    success: true,
    data: { ...key, key: plaintext },
  });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "id is required" },
      { status: 400 }
    );
  }

  // Scoped by workspaceId so one tenant cannot revoke another tenant's key.
  // Revoking stamps revokedAt rather than deleting the row, so the audit trail
  // of what existed and when it was used survives.
  const result = await prisma.apiKey.updateMany({
    where: {
      id: parsed.data.id,
      workspaceId: context.workspaceId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { success: false, error: "Key not found" },
      { status: 404 }
    );
  }

  // revokedAt already records when. This records who, which it could not.
  await recordAuditEvent({
    workspaceId: context.workspaceId,
    action: "api_key.revoked",
    actorUserId: context.userId,
    targetId: parsed.data.id,
  });

  return NextResponse.json({ success: true });
}
