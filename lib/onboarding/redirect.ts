/**
 * Deciding whether someone belongs on onboarding rather than on the portal.
 *
 * The portal is a cockpit. With no campaigns it shows five zeroed KPI cards
 * and three empty lanes, which tells a new user nothing and asks them to go
 * find a builder. A workspace in that state should be handed finished
 * automations instead.
 *
 * This lives here, in one function, so the page that owns the redirect can
 * make the decision in a single line rather than restating the rule.
 */

import { prisma } from "@/lib/db/client";

/**
 * True when this workspace has never made a campaign.
 *
 * One condition, deliberately. It used to also require an Instagram account,
 * on the reasoning that without one there is nothing to suggest and those
 * users "belong on the connect step". There was no connect step: they fell
 * through to the portal and got the empty cockpit this file exists to avoid.
 * Onboarding now owns that case and shows them how to connect.
 *
 * Note it is campaigns, not live campaigns. Someone who deliberately paused
 * everything has already been through this and would resent being sent back.
 */
export async function shouldSeeOnboarding(
  workspaceId: string
): Promise<boolean> {
  const campaigns = await prisma.automation.count({ where: { workspaceId } });

  return campaigns === 0;
}
