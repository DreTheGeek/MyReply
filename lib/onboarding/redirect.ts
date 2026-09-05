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
 * True when this workspace should be sent to onboarding.
 *
 * Two conditions, both required:
 *
 *  - It has an Instagram account connected. Without one there is nothing to
 *    read and nothing to suggest, so onboarding would be as empty as the
 *    portal. Those users belong on the connect step.
 *
 *  - It has no campaigns at all. Not "no live campaigns": a user who
 *    deliberately paused everything has already been through this and would
 *    resent being sent back. Only a workspace that has never made one is new.
 */
export async function shouldSeeOnboarding(
  workspaceId: string
): Promise<boolean> {
  const [accounts, campaigns] = await Promise.all([
    prisma.instagramAccount.count({ where: { workspaceId } }),
    prisma.automation.count({ where: { workspaceId } }),
  ]);

  return accounts > 0 && campaigns === 0;
}
