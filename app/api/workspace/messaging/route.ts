import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { isValidTimezone } from "@/lib/messaging/quiet-hours";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * When this workspace is allowed to send a follow-up.
 *
 * Read by anyone in the workspace, changed by owners and admins. The window
 * gates follow-ups only, never a campaign's first reply, which is explained
 * where it is enforced in lib/queue/dm-worker.ts.
 */
const settingsSchema = z.object({
  // Validated against Intl rather than a hardcoded list, so the set stays
  // whatever the runtime actually understands. A zone the server cannot read
  // would make every quiet-hours check fail open and silently do nothing.
  timezone: z.string().min(1).refine(isValidTimezone, {
    message: "Not a timezone this server recognises",
  }),
  quietHoursEnabled: z.boolean(),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
});

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: context.workspaceId },
    select: {
      timezone: true,
      quietHoursEnabled: true,
      quietHoursStart: true,
      quietHoursEnd: true,
    },
  });

  if (!workspace) {
    return NextResponse.json(
      { success: false, error: "Workspace not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    data: { ...workspace, canManage: canManageWorkspace(context.role) },
  });
}

export async function PATCH(request: NextRequest) {
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
        error: "Only owners and admins can change messaging settings",
      },
      { status: 403 }
    );
  }

  const parsed = settingsSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error:
          parsed.error.issues[0]?.message ??
          "Check the timezone and the hours.",
      },
      { status: 400 }
    );
  }

  const workspace = await prisma.workspace.update({
    where: { id: context.workspaceId },
    data: parsed.data,
    select: {
      timezone: true,
      quietHoursEnabled: true,
      quietHoursStart: true,
      quietHoursEnd: true,
    },
  });

  return NextResponse.json({
    success: true,
    data: { ...workspace, canManage: true },
  });
}
