import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/auth";
import { listUserWorkspaces, setActiveWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

const switchSchema = z.object({
  workspaceId: z.string().min(1),
});

/**
 * The workspaces this user may act in. Used by the sidebar switcher.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const workspaces = await listUserWorkspaces(userId);
  return NextResponse.json({ success: true, data: { workspaces } });
}

export async function POST(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = switchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "workspaceId is required" },
      { status: 400 }
    );
  }

  // setActiveWorkspace refuses ids the user is not a member of, so a guessed
  // or stale workspace id cannot be used to reach another tenant's data.
  const switched = await setActiveWorkspace(userId, parsed.data.workspaceId);
  if (!switched) {
    return NextResponse.json(
      { success: false, error: "Workspace not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
