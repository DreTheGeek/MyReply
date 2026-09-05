import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { type PlanFeature, requirePlan } from "@/lib/plans";

/**
 * The bridge between a route and the plan matrix.
 *
 * lib/plans.ts held a finished, tested gate that exactly one route called, and
 * that route was the one which *reports* entitlements rather than enforcing
 * them. So every paid feature was available on the free plan. This is the
 * missing half: it loads the workspace's plan and answers with the 402 the gate
 * already describes.
 *
 * 402 rather than 403 on purpose. A client needs to tell "your plan does not
 * include this", which an upgrade fixes, from "you are not allowed", which it
 * does not.
 */
export async function checkPlanFeature(
  workspaceId: string,
  feature: PlanFeature
): Promise<NextResponse | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true },
  });

  // A workspace that has gone missing is not a billing problem, and answering
  // "upgrade to continue" would be a confusing lie. Let the caller's own
  // not-found handling deal with it.
  if (!workspace) return null;

  const verdict = requirePlan(workspace.plan, feature);
  if (verdict.allowed) return null;

  return NextResponse.json(
    {
      success: false,
      error: verdict.error,
      feature: verdict.feature,
      requiredPlan: verdict.requiredPlan,
    },
    { status: verdict.status }
  );
}
