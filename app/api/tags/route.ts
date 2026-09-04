import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureTag } from "@/lib/contacts";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export interface TagListItem {
  id: string;
  name: string;
  color: string | null;
  contactCount: number;
}

const createTagSchema = z.object({
  name: z.string().min(1).max(60),
  // Hex only. The value lands straight in a style attribute, so anything else
  // is refused rather than sanitised.
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
});

const deleteTagSchema = z.object({
  id: z.string().min(1),
});

async function listTags(workspaceId: string): Promise<TagListItem[]> {
  const tags = await prisma.tag.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      color: true,
      _count: { select: { contacts: true } },
    },
  });

  return tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    contactCount: tag._count.contacts,
  }));
}

export async function GET(): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  return NextResponse.json({
    success: true,
    data: { tags: await listTags(context.workspaceId) },
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
      { success: false, error: "Only owners and admins can create tags" },
      { status: 403 }
    );
  }

  const parsed = createTagSchema.safeParse(
    await request.json().catch(() => ({}))
  );
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid tag" },
      { status: 400 }
    );
  }

  // ensureTag upserts on workspace plus normalised name, so creating a tag that
  // already exists returns the existing one instead of failing.
  const tag = await ensureTag({
    workspaceId: context.workspaceId,
    name: parsed.data.name,
    color: parsed.data.color ?? null,
  });

  return NextResponse.json({
    success: true,
    data: { tag, tags: await listTags(context.workspaceId) },
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
      { success: false, error: "Only owners and admins can delete tags" },
      { status: 403 }
    );
  }

  const parsed = deleteTagSchema.safeParse(
    await request.json().catch(() => ({}))
  );
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Missing tag ID" },
      { status: 400 }
    );
  }

  // deleteMany keeps the workspace in the where clause, so a tag id from
  // another tenant deletes nothing instead of throwing on a missing row.
  const deleted = await prisma.tag.deleteMany({
    where: { id: parsed.data.id, workspaceId: context.workspaceId },
  });
  if (deleted.count === 0) {
    return NextResponse.json(
      { success: false, error: "Tag not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    data: { tags: await listTags(context.workspaceId) },
  });
}
