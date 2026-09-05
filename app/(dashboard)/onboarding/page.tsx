/**
 * Onboarding.
 *
 * Where a new workspace lands. Reads only what the screen needs to decide
 * which of the three steps are already done, then hands over to the client
 * component that fetches the drafts.
 *
 * A workspace with no Instagram account cannot be given suggestions at all, so
 * it is sent to the connect step rather than shown an empty screen.
 */

import { redirect } from "next/navigation";
import OnboardingScreen from "@/components/onboarding/onboarding-screen";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

// Reads the signed-in workspace on every request; nothing here is shareable
// between tenants.
export const dynamic = "force-dynamic";

export default async function OnboardingPage(): Promise<React.JSX.Element> {
  const context = await getCurrentWorkspaceContext();
  if (!context) redirect("/login?session=expired");

  const account = await getWorkspaceInstagramAccount(context.workspaceId);

  // Nothing to suggest from and nothing to send with. Settings is where the
  // connect button lives.
  if (!account) redirect("/settings");

  const liveCampaigns = await prisma.automation.count({
    where: { workspaceId: context.workspaceId, isActive: true },
  });

  return (
    <OnboardingScreen
      username={account.username}
      hasLiveCampaign={liveCampaigns > 0}
    />
  );
}
