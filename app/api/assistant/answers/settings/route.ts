import { NextRequest, NextResponse } from "next/server";
import { checkPlanFeature } from "@/lib/plan-gate";
import {
  answeringSettingsSchema,
  getAnsweringSettings,
  saveAnsweringSettings,
} from "@/lib/ai/answering-settings";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET and PUT /api/assistant/answers/settings
 *
 * Sits under the answers path rather than beside it because it is the same
 * feature: these four values decide which answers get sent and which ones land
 * in the queue the sibling route serves. The static segment wins over any
 * future [id] route, so the two cannot collide.
 *
 * Any member can read the settings, because a member working the review queue
 * needs to know what threshold produced it. Only owners and admins can change
 * them: this is the switch that decides whether a model talks to customers.
 */

export async function GET(): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const settings = await getAnsweringSettings(context.workspaceId);

  return NextResponse.json({
    success: true,
    data: { ...settings, canManage: canManageWorkspace(context.role) },
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
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
        error: "Only owners and admins can change answering settings",
      },
      { status: 403 }
    );
  }

  // Answering customer DMs is a paid feature and was reachable on every plan.
  const planGate = await checkPlanFeature(context.workspaceId, "ai_dm_answering");
  if (planGate) return planGate;

  const parsed = answeringSettingsSchema.safeParse(
    await request.json().catch(() => ({}))
  );
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Those answering settings are not valid." },
      { status: 400 }
    );
  }

  try {
    const settings = await saveAnsweringSettings({
      workspaceId: context.workspaceId,
      settings: parsed.data,
      updatedByUserId: context.userId || null,
    });

    return NextResponse.json({
      success: true,
      data: { ...settings, canManage: true },
    });
  } catch (error) {
    console.error("[assistant-answers] settings save failed", {
      workspaceId: context.workspaceId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json(
      { success: false, error: "Could not save those settings." },
      { status: 500 }
    );
  }
}
