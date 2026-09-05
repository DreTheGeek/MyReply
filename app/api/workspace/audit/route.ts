import { NextRequest, NextResponse } from "next/server";
import { AUDIT_ACTIONS, AUDIT_ACTION_LABELS, type AuditAction } from "@/lib/audit";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * Who did what, and when.
 *
 * The rows have been written since lib/audit.ts landed and nothing has ever
 * read them. This is the reader.
 *
 * ADMIN ONLY, unlike the export route. An audit log's whole subject is other
 * people's actions, and "which member deleted which campaign" is not something
 * every member should be able to pull. Export is the workspace's own data,
 * which anyone in it can already see; this is a record about colleagues.
 *
 * Audit rows share OperationalEvent with worker failures and webhook warnings,
 * so they are identified by their message being one of the known actions
 * rather than by a flag, which keeps the writer from needing a schema change
 * every time an action is added.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

interface AuditPayload {
  actorUserId: string | null;
  targetId: string | null;
  [key: string]: unknown;
}

export async function GET(request: NextRequest) {
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
        error: "Only owners and admins can read the audit log",
      },
      { status: 403 }
    );
  }

  const cursor = request.nextUrl.searchParams.get("cursor");

  const rows = await prisma.operationalEvent.findMany({
    where: {
      workspaceId: context.workspaceId,
      message: { in: [...AUDIT_ACTIONS] },
    },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      message: true,
      payload: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  // The actor is stored as an id. Resolve the ones on this page in one query
  // rather than joining, because the column has no relation: an event outlives
  // the user who caused it, which is the point of an audit log.
  const actorIds = Array.from(
    new Set(
      page
        .map((row) => (row.payload as AuditPayload | null)?.actorUserId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  );

  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];

  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  return NextResponse.json({
    success: true,
    data: {
      entries: page.map((row) => {
        const payload = (row.payload ?? {}) as AuditPayload;
        const actor = payload.actorUserId
          ? actorById.get(payload.actorUserId)
          : null;

        return {
          id: row.id,
          action: row.message,
          label:
            AUDIT_ACTION_LABELS[row.message as AuditAction] ?? row.message,
          // Null actor is a real state, not missing data: an API key has no
          // user behind it, and a removed teammate leaves their actions behind.
          actor: actor
            ? { name: actor.name, email: actor.email }
            : payload.actorUserId
              ? { name: null, email: null }
              : null,
          targetId: payload.targetId ?? null,
          detail: Object.fromEntries(
            Object.entries(payload).filter(
              ([key]) => key !== "actorUserId" && key !== "targetId"
            )
          ),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    },
  });
}
