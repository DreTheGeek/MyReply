import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";
import { getCurrentUserId, getRequestApiKeyContext } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getWorkspaceMembership } from "@/lib/workspace";

export type WorkspaceContext = {
  userId: string;
  workspaceId: string;
  workspace: Workspace;
  role: WorkspaceRole;
};

const ROLE_ORDER: Record<WorkspaceRole, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function hasWorkspaceRole(
  role: WorkspaceRole,
  minimumRole: WorkspaceRole
) {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimumRole];
}

export function canManageWorkspace(role: WorkspaceRole) {
  return hasWorkspaceRole(role, "ADMIN");
}

export function canManageBilling(role: WorkspaceRole) {
  return role === "OWNER";
}

export async function getCurrentWorkspaceContext(): Promise<WorkspaceContext | null> {
  // Machine callers carry their workspace and role on the key itself. There is
  // no user behind them, so userId is empty and role gating uses the key's role.
  const apiKeyContext = await getRequestApiKeyContext();
  if (apiKeyContext) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: apiKeyContext.workspaceId },
    });
    if (!workspace) return null;

    return {
      userId: "",
      workspaceId: workspace.id,
      workspace,
      role: apiKeyContext.role,
    };
  }

  const userId = await getCurrentUserId();
  if (!userId) return null;

  // Shares one resolver with getCurrentWorkspaceId so the active-workspace
  // preference and its membership re-check cannot drift between the two.
  const membership = await getWorkspaceMembership(userId);

  if (membership) {
    return {
      userId,
      workspaceId: membership.workspace.id,
      workspace: membership.workspace,
      role: membership.role,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const workspace = await ensureWorkspaceForUser(userId, user?.email);
  const createdMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId,
      },
    },
  });

  return {
    userId,
    workspaceId: workspace.id,
    workspace,
    role: createdMembership?.role ?? "OWNER",
  };
}

