import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * Disconnecting one Instagram account.
 *
 * The account id is required, and that is the whole point of this file. It
 * used to be spread in conditionally:
 *
 *   where: { workspaceId, ...(instagramAccountId ? { id: instagramAccountId } : {}) }
 *
 * so a request whose body was absent, empty, or carried a non-string id did
 * not fail. It widened to every account in the workspace, and the cascades
 * took every Automation, DmLog, Contact, TrackedLink, LinkClick,
 * OutboundMessage and FollowerSnapshot with them. A dropped body on a retry
 * was enough to wipe a tenant, with no audit row and nothing to restore from.
 *
 * The id is now parsed rather than sniffed, and the delete is keyed on it.
 */
const disconnectSchema = z.object({
  instagramAccountId: z.string().min(1),
});

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
      { success: false, error: "Only owners and admins can disconnect accounts" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = disconnectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Name the account to disconnect. instagramAccountId is required, so that a malformed request can never widen into disconnecting every account.",
      },
      { status: 400 }
    );
  }

  // Both keys in the same predicate: the id says which account, the workspace
  // id says it has to be one of theirs.
  const result = await prisma.instagramAccount.deleteMany({
    where: {
      id: parsed.data.instagramAccountId,
      workspaceId: context.workspaceId,
    },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { success: false, error: "That account is not connected to this workspace." },
      { status: 404 }
    );
  }

  // Disconnecting destroys the campaigns and the delivery history behind it,
  // so it leaves a trace saying who did it and when.
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: context.workspaceId,
        source: "SYSTEM",
        level: "INFO",
        message: "Instagram account disconnected",
        payload: {
          instagramAccountId: parsed.data.instagramAccountId,
          actorUserId: context.userId || null,
        },
        resolvedAt: new Date(),
      },
    })
    .catch((error) => {
      // The account is already gone. Failing the response now would tell the
      // caller the disconnect did not happen, which is worse than a missing
      // audit row, so this is logged and swallowed on purpose.
      console.error("Failed to record disconnect audit event", error);
    });

  return NextResponse.json({ success: true });
}
