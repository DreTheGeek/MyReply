import { redirect } from "next/navigation";
import PortalPage from "@/components/portal/portal-page";
import { shouldSeeOnboarding } from "@/lib/onboarding/redirect";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * The portal, or setup, depending on whether there is anything to look at.
 *
 * Login lands here, and a workspace that has connected Instagram but never made
 * a campaign would otherwise arrive at five zeroed KPI cards and three empty
 * lanes, which is a cockpit with nothing in it and teaches a new user nothing.
 *
 * A thin server wrapper rather than a check inside the portal itself, because
 * the portal is a client component and cannot redirect before it renders. It is
 * deliberately not in the group layout either: that would trap someone on
 * onboarding and block /campaigns/new, which is exactly where a person who
 * wants to skip the suggestions is trying to go.
 *
 * redirect() throws NEXT_REDIRECT, so it must stay outside any try block.
 */
export default async function DashboardPage(): Promise<React.JSX.Element> {
  const context = await getCurrentWorkspaceContext();

  if (context && (await shouldSeeOnboarding(context.workspaceId))) {
    redirect("/onboarding");
  }

  return <PortalPage />;
}
