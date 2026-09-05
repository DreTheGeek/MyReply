/**
 * Onboarding.
 *
 * Where a new workspace lands. Reads only what the screen needs to decide
 * which of the three steps are already done, then hands over to the client
 * component that fetches the drafts.
 *
 * A workspace with no Instagram account cannot be given suggestions at all, so
 * it gets the connect step rather than an empty screen.
 */

import { redirect } from "next/navigation";
import ConnectStep from "@/components/onboarding/connect-step";
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

  // Nothing to suggest from and nothing to send with. This used to redirect
  // to /settings, which is a dense page whose connect button is one row among
  // many, and the dashboard never sent anyone here in that state anyway. The
  // first screen after signing up is now a single instruction.
  if (!account) return <ConnectStep />;

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
