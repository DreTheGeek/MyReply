import type { WorkspaceRole } from "@/app/generated/prisma/client";

/**
 * The role ladder, as pure functions.
 *
 * Deliberately a leaf module with no imports beyond the generated types.
 * These live apart from lib/workspace-access so that code which only needs to
 * compare two roles does not pull in NextAuth and the database client along
 * with them. lib/workspace-access re-exports all three, so existing callers
 * are unaffected.
 */

const ROLE_ORDER: Record<WorkspaceRole, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function hasWorkspaceRole(
  role: WorkspaceRole,
  minimumRole: WorkspaceRole
): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimumRole];
}

export function canManageWorkspace(role: WorkspaceRole): boolean {
  return hasWorkspaceRole(role, "ADMIN");
}

export function canManageBilling(role: WorkspaceRole): boolean {
  return role === "OWNER";
}
