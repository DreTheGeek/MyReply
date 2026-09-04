import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tagContact, untagContact } from "@/lib/contacts";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import type { ContactTagSummary } from "@/app/api/contacts/route";

const tagBodySchema = z.object({
  tagId: z.string().min(1),
});

type RouteProps = { params: Promise<{ id: string }> };

type Resolution =
  | { ok: true; contactId: string; tagId: string; workspaceId: string }
  | { ok: false; response: NextResponse };

/**
 * Auth, role gate, body parse, and the two ownership checks that matter: the
 * contact and the tag must both sit in the caller's workspace. Without the
 * second check a tenant could staple its own tag onto someone else's contact,
 * or discover which tag ids exist elsewhere.
 */
async function resolveTagWrite(
  request: NextRequest,
  params: RouteProps["params"]
): Promise<Resolution> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      ),
    };
  }
  if (!canManageWorkspace(context.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "Only owners and admins can tag contacts" },
        { status: 403 }
      ),
    };
  }

  const parsed = tagBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "Invalid tag request" },
        { status: 400 }
      ),
    };
  }

  const { id: contactId } = await params;

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!contact) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "Contact not found" },
        { status: 404 }
      ),
    };
  }

  const tag = await prisma.tag.findFirst({
    where: { id: parsed.data.tagId, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!tag) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "Tag not found" },
        { status: 404 }
      ),
    };
  }

  return {
    ok: true,
    contactId: contact.id,
    tagId: tag.id,
    workspaceId: context.workspaceId,
  };
}

async function getContactTags(
  contactId: string,
  workspaceId: string
): Promise<ContactTagSummary[]> {
  const rows = await prisma.contactTag.findMany({
    where: { contactId, tag: { workspaceId } },
    orderBy: { createdAt: "asc" },
    select: { tag: { select: { id: true, name: true, color: true } } },
  });

  return rows.map((row) => row.tag);
}

export async function POST(
  request: NextRequest,
  { params }: RouteProps
): Promise<NextResponse> {
  const resolved = await resolveTagWrite(request, params);
  if (!resolved.ok) return resolved.response;

  await tagContact(resolved.contactId, resolved.tagId);

  return NextResponse.json({
    success: true,
    data: {
      contactId: resolved.contactId,
      tags: await getContactTags(resolved.contactId, resolved.workspaceId),
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteProps
): Promise<NextResponse> {
  const resolved = await resolveTagWrite(request, params);
  if (!resolved.ok) return resolved.response;

  await untagContact(resolved.contactId, resolved.tagId);

  return NextResponse.json({
    success: true,
    data: {
      contactId: resolved.contactId,
      tags: await getContactTags(resolved.contactId, resolved.workspaceId),
    },
  });
}
