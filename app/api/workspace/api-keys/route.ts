import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { generateApiKey } from "@/lib/api-keys";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
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

/** List this workspace's keys. Never returns a key, only its metadata. */
export async function GET() {
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

  return NextResponse.json({ success: true, data: { keys } });
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
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "A name is required" },
      { status: 400 }
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
    select: { id: true, name: true, prefix: true, role: true, expiresAt: true },
  });

  // The only time the plaintext key exists outside the caller's hands. It is
  // not stored and cannot be shown again.
  return NextResponse.json({
    success: true,
    data: { ...key, key: plaintext },
  });
}

export async function DELETE(request: NextRequest) {
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

  const body = await request.json().catch(() => ({}));
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "id is required" },
      { status: 400 }
    );
  }

  // Scoped by workspaceId so one tenant cannot revoke another tenant's key.
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

  return NextResponse.json({ success: true });
}
