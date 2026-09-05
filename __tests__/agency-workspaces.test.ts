import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    // Read to decide how many accounts this plan allows.
    workspace: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import {
  canConnectInstagramAccount,
  getWorkspaceInstagramAccount,
} from "../lib/instagram-accounts";
import {
  buildInvitationUrl,
  normalizeInvitationEmail,
} from "../lib/workspace-invitations";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agency workspace helpers", () => {
  it("allows reconnecting an account already owned by the workspace", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_123",
    });

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: true, reason: null });
  });

  it("blocks accounts already connected to another workspace", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_other",
    });

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "already_connected",
    });
  });

  it("allows the first account on any plan", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue(null);
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "FREE" });
    mockPrisma.instagramAccount.count.mockResolvedValue(0);

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: true, reason: null });
  });

  it("refuses a second account on Free, the one capped resource", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue(null);
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "FREE" });
    mockPrisma.instagramAccount.count.mockResolvedValue(1);

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: false, reason: "plan_limit" });
  });

  it("allows a second account on Pro", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue(null);
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" });
    mockPrisma.instagramAccount.count.mockResolvedValue(7);

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: true, reason: null });
    // Unlimited means the count is never even asked for a comparison it
    // cannot fail, so a Pro workspace pays no query for a cap it does not have.
    expect(mockPrisma.instagramAccount.count).not.toHaveBeenCalled();
  });

  it("never refuses a reconnect of an account this workspace already holds", async () => {
    // The callback upserts on instagramId, so refreshing an expired token must
    // not be read as connecting a new account and refused for hitting the cap.
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_123",
    });
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "FREE" });
    mockPrisma.instagramAccount.count.mockResolvedValue(1);

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: true, reason: null });
  });

  it("selects a requested workspace account or falls back to the latest account", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "account_1" });

    await getWorkspaceInstagramAccount("workspace_123", "account_1");
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "account_1", workspaceId: "workspace_123" },
    });

    await getWorkspaceInstagramAccount("workspace_123", "all");
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenLastCalledWith({
      where: { workspaceId: "workspace_123" },
      orderBy: { connectedAt: "desc" },
    });
  });

  it("normalizes invitation emails and builds invite URLs", () => {
    expect(normalizeInvitationEmail(" Team@Agency.COM ")).toBe(
      "team@agency.com"
    );
    expect(buildInvitationUrl("token_123", "https://manychat-alternative.com/")).toBe(
      "https://manychat-alternative.com/invite/token_123"
    );
  });
});

