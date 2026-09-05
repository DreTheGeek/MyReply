import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { count: vi.fn() },
    automation: { count: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { shouldSeeOnboarding } from "../lib/onboarding/redirect";

function workspaceWith(accounts: number, campaigns: number): void {
  mockPrisma.instagramAccount.count.mockResolvedValue(accounts);
  mockPrisma.automation.count.mockResolvedValue(campaigns);
}

describe("who belongs on onboarding rather than the portal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a connected workspace with no campaigns to onboarding", async () => {
    workspaceWith(1, 0);
    expect(await shouldSeeOnboarding("workspace_1")).toBe(true);
  });

  it("leaves a workspace that already has a campaign on the portal", async () => {
    workspaceWith(1, 1);
    expect(await shouldSeeOnboarding("workspace_1")).toBe(false);
  });

  it("does not send someone to onboarding with nothing connected to read", async () => {
    workspaceWith(0, 0);
    expect(await shouldSeeOnboarding("workspace_1")).toBe(false);
  });

  it("counts a paused campaign, so nobody is dragged back through onboarding", async () => {
    workspaceWith(1, 2);
    expect(await shouldSeeOnboarding("workspace_1")).toBe(false);

    // The rule is "has never made one", not "has none live": the count query
    // must not filter on isActive.
    const [[query]] = mockPrisma.automation.count.mock.calls;
    expect(query.where).toEqual({ workspaceId: "workspace_1" });
  });

  it("scopes both counts to the workspace it was asked about", async () => {
    workspaceWith(1, 0);
    await shouldSeeOnboarding("workspace_9");

    expect(mockPrisma.instagramAccount.count).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_9" },
    });
    expect(mockPrisma.automation.count).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_9" },
    });
  });
});
