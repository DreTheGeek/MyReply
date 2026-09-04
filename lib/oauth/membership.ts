import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * The role a user holds in a workspace right now, or null if they hold none.
 *
 * Consent records what a person agreed to; it is not a standing grant. This is
 * re-read when a code is exchanged for a token and again on every MCP request,
 * so somebody removed from a workspace loses access on their next call rather
 * than when their token happens to expire.
 */
export async function getMembershipRole(
  userId: string,
  workspaceId: string
): Promise<WorkspaceRole | null> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });

  return membership?.role ?? null;
}
