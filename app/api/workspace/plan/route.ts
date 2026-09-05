import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  PLAN_IDS,
  getPlanEntitlements,
  isPlanFeature,
  requirePlan,
} from "@/lib/plans";
import {
  canManageBilling,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/POST /api/workspace/plan.
 *
 * GET returns the workspace's plan and everything it unlocks, read from
 * lib/plans so the dashboard, the marketing page and the gate all answer from
 * one table. Pass ?feature=<key> and it also returns the gate's verdict on that
 * one feature, which is the same call any other route makes before doing paid
 * work.
 *
 * POST changes the plan and is owner only. It is deliberately thin: this is
 * where Stripe lands later, and when it does the checkout session and the
 * webhook slot in around this write rather than replacing it. Machine callers
 * cannot reach it at all, since API keys top out at ADMIN and billing is OWNER.
 */

const updateSchema = z.object({
  plan: z.enum(PLAN_IDS),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const plan = context.workspace.plan;
  const entitlements = getPlanEntitlements(plan);

  const requested = request.nextUrl.searchParams.get("feature");
  if (requested !== null && !isPlanFeature(requested)) {
    return NextResponse.json(
      { success: false, error: "Unknown feature" },
      { status: 400 }
    );
  }

  const gate = requested === null ? null : requirePlan(plan, requested);

  return NextResponse.json({
    success: true,
    data: {
      ...entitlements,
      canManagePlan: canManageBilling(context.role),
      ...(gate === null ? {} : { gate }),
    },
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

  if (!canManageBilling(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only the workspace owner can change the plan" },
      { status: 403 }
    );
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid plan" },
      { status: 400 }
    );
  }

  const plan = parsed.data.plan;

  // Upgrading is not something a workspace may do to itself. Until Square is
  // wired, this route can only downgrade, because a self-serve upgrade here is
  // the entire paid tier given away to anyone who can send one fetch. The
  // upgrade path arrives with the payment webhook, which is the only caller
  // that will have proof a subscription exists.
  if (plan === "PRO") {
    return NextResponse.json(
      {
        success: false,
        error:
          "Upgrades happen through checkout, not this endpoint. Start one from Settings.",
      },
      { status: 402 }
    );
  }

  // The seam. The payment webhook writes PRO here once a subscription is
  // verified; this route handles the downgrade half.
  const workspace = await prisma.workspace.update({
    where: { id: context.workspaceId },
    data: { plan },
    select: { id: true, plan: true },
  });

  return NextResponse.json({
    success: true,
    data: {
      ...getPlanEntitlements(workspace.plan),
      canManagePlan: true,
    },
  });
}
