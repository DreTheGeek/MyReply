import { prisma } from "@/lib/db/client";
import { PLAN_LIMITS, UNLIMITED } from "@/lib/plans";

/**
 * Whether this workspace may connect this account.
 *
 * The plan check lives here rather than in the OAuth callback because this is
 * the one chokepoint every caller already passes through, so a future connect
 * path cannot forget it.
 *
 * Connected accounts are the single capped resource on the free plan, and the
 * only one where the zero-marginal-cost rule does not hold: each account
 * multiplies webhook volume, worker load and stored rows for as long as it
 * stays connected.
 */
export async function canConnectInstagramAccount({
  workspaceId,
  instagramId,
}: {
  workspaceId: string;
  instagramId: string;
}) {
  const existingAccount = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { workspaceId: true },
  });

  if (existingAccount && existingAccount.workspaceId !== workspaceId) {
    return {
      allowed: false,
      reason: "already_connected" as const,
    };
  }

  // Reconnecting an account this workspace already holds is not a new seat.
  // The callback upserts on instagramId, so refreshing an expired token must
  // never be refused for hitting the cap.
  if (existingAccount?.workspaceId === workspaceId) {
    return { allowed: true, reason: null };
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true },
  });

  const limit = PLAN_LIMITS[workspace?.plan ?? "FREE"].instagramAccounts;
  if (limit !== UNLIMITED) {
    const connected = await prisma.instagramAccount.count({
      where: { workspaceId },
    });
    if (connected >= limit) {
      return {
        allowed: false,
        reason: "plan_limit" as const,
      };
    }
  }

  return {
    allowed: true,
    reason: null,
  };
}

export async function getWorkspaceInstagramAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  if (instagramAccountId && instagramAccountId !== "all") {
    return prisma.instagramAccount.findFirst({
      where: { id: instagramAccountId, workspaceId },
    });
  }

  return prisma.instagramAccount.findFirst({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
  });
}

