import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { count: vi.fn() },
    automation: { count: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { shouldSeeOnboarding } from "../lib/onboarding/redirect";

function workspaceWith(campaigns: number): void {
  mockPrisma.automation.count.mockResolvedValue(campaigns);
}

describe("who belongs on onboarding rather than the portal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a workspace with no campaigns to onboarding", async () => {
    workspaceWith(0);
    expect(await shouldSeeOnboarding("workspace_1")).toBe(true);
  });

  it("leaves a workspace that already has a campaign on the portal", async () => {
    workspaceWith(1);
    expect(await shouldSeeOnboarding("workspace_1")).toBe(false);
  });

  // This assertion is the inverse of what it used to be, deliberately.
  //
  // The rule was `accounts > 0 && campaigns === 0`, on the reasoning that a
  // workspace with nothing connected has nothing to suggest from and "belongs
  // on the connect step". No connect step existed. Those users fell through to
  // the portal and got five zeroed KPI cards and three empty lanes, which is
  // the exact screen this redirect was written to avoid, on the first visit
  // after signing up. Onboarding now owns that case.
  it("sends a workspace with nothing connected to onboarding, not to the empty portal", async () => {
    workspaceWith(0);
    expect(await shouldSeeOnboarding("workspace_1")).toBe(true);
  });

  it("does not ask about accounts at all any more", async () => {
    workspaceWith(0);
    await shouldSeeOnboarding("workspace_1");

    // Whether an account is connected decides which onboarding step renders,
    // not whether the person goes there, so this query is no longer part of
    // the decision and should not be paid for on every dashboard load.
    expect(mockPrisma.instagramAccount.count).not.toHaveBeenCalled();
  });

  it("counts a paused campaign, so nobody is dragged back through onboarding", async () => {
    workspaceWith(2);
    expect(await shouldSeeOnboarding("workspace_1")).toBe(false);

    // The rule is "has never made one", not "has none live": the count query
    // must not filter on isActive.
    const [[query]] = mockPrisma.automation.count.mock.calls;
    expect(query.where).toEqual({ workspaceId: "workspace_1" });
  });

  it("scopes the count to the workspace it was asked about", async () => {
    workspaceWith(0);
    await shouldSeeOnboarding("workspace_9");

    expect(mockPrisma.automation.count).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_9" },
    });
  });
});
