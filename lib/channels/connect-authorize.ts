import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { returnUrlWithOutcome } from "@/lib/partners/links";
import type { HostedConnect } from "@/lib/security/oauth-state";
import { canManageWorkspace } from "@/lib/workspace-access";

/**
 * Who may finish connecting an account to the workspace in a verified OAuth
 * state, and where the person goes afterwards.
 *
 * Two ways in. Someone signed in here who manages the workspace, as always.
 * Or a partner's hosted connect link: the partner minted the link for one of
 * its own workspaces, so there is no session to check. Instead the workspace
 * must still belong to that partner, and the partner must not be disabled.
 */

export type ConnectPermission = "ok" | "login" | "forbidden";

export async function mayFinishConnect(state: {
  workspaceId: string;
  hosted?: HostedConnect;
}): Promise<ConnectPermission> {
  if (state.hosted) {
    const workspace = await prisma.workspace.findFirst({
      where: {
        id: state.workspaceId,
        partnerId: state.hosted.partnerId,
        partner: { disabledAt: null },
      },
      select: { id: true },
    });
    return workspace ? "ok" : "forbidden";
  }

  const session = await auth();
  if (!session?.user?.id) return "login";

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  return membership && canManageWorkspace(membership.role) ? "ok" : "forbidden";
}

/**
 * Where a connect outcome lands. A hosted connect goes back to the partner's
 * app with the outcome on the URL; everyone else to their own settings page.
 */
export function connectOutcomeUrl(
  state: { workspaceId: string; hosted?: HostedConnect } | null,
  outcome: { platformKey: string; status: string; connected?: number; settingsUrl?: string }
): string {
  if (state?.hosted) {
    return returnUrlWithOutcome(state.hosted.returnUrl, {
      status: outcome.status,
      platform: outcome.platformKey,
      workspaceId: state.workspaceId,
      connected: outcome.connected,
    });
  }
  return (
    outcome.settingsUrl ??
    `${getBaseUrl()}/settings?${outcome.platformKey}=${outcome.status}${
      outcome.connected !== undefined ? `&count=${outcome.connected}` : ""
    }`
  );
}
