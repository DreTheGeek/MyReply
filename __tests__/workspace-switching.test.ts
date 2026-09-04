import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workspaceMember: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import {
  getWorkspaceMembership,
  listUserWorkspaces,
  setActiveWorkspace,
} from "../lib/workspace";

const OLDEST = {
  workspace: { id: "ws_oldest", name: "Oldest workspace" },
  role: "OWNER",
};
const ACTIVE = {
  workspace: { id: "ws_active", name: "Client workspace" },
  role: "ADMIN",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWorkspaceMembership", () => {
  it("falls back to the oldest membership when no active workspace is set", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ activeWorkspaceId: null });
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(OLDEST);

    await expect(getWorkspaceMembership("user_1")).resolves.toMatchObject({
      workspace: { id: "ws_oldest" },
      role: "OWNER",
    });
    expect(mockPrisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("uses the active workspace when the user is still a member of it", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      activeWorkspaceId: "ws_active",
    });
    mockPrisma.workspaceMember.findUnique.mockResolvedValue(ACTIVE);

    await expect(getWorkspaceMembership("user_1")).resolves.toMatchObject({
      workspace: { id: "ws_active" },
      role: "ADMIN",
    });
    // The oldest-membership query must not run when the active id resolves.
    expect(mockPrisma.workspaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("carries the role of the active workspace, not the fallback one", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      activeWorkspaceId: "ws_active",
    });
    mockPrisma.workspaceMember.findUnique.mockResolvedValue(ACTIVE);

    const membership = await getWorkspaceMembership("user_1");
    expect(membership?.role).toBe("ADMIN");
  });

  it("ignores an active workspace the user is no longer a member of", async () => {
    // The stored preference is stale, e.g. the user was removed from that
    // workspace. It must not grant access, and must not strand the user either.
    mockPrisma.user.findUnique.mockResolvedValue({
      activeWorkspaceId: "ws_revoked",
    });
    mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(OLDEST);

    await expect(getWorkspaceMembership("user_1")).resolves.toMatchObject({
      workspace: { id: "ws_oldest" },
    });
  });

  it("returns null when the user belongs to no workspace at all", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ activeWorkspaceId: null });
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);

    await expect(getWorkspaceMembership("user_1")).resolves.toBeNull();
  });

  it("survives a missing user row", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(OLDEST);

    await expect(getWorkspaceMembership("user_1")).resolves.toMatchObject({
      workspace: { id: "ws_oldest" },
    });
  });
});

describe("setActiveWorkspace", () => {
  it("switches when the user is a member", async () => {
    mockPrisma.workspaceMember.findUnique.mockResolvedValue({ id: "member_1" });
    mockPrisma.user.update.mockResolvedValue({});

    await expect(setActiveWorkspace("user_1", "ws_active")).resolves.toBe(true);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { activeWorkspaceId: "ws_active" },
    });
  });

  it("refuses a workspace the user does not belong to, and writes nothing", async () => {
    // This is the whole security property of the switch endpoint.
    mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);

    await expect(setActiveWorkspace("user_1", "ws_someone_else")).resolves.toBe(
      false
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe("listUserWorkspaces", () => {
  it("returns every workspace the user is a member of, with their role", async () => {
    mockPrisma.workspaceMember.findMany.mockResolvedValue([
      { workspace: { id: "ws_a", name: "Agency" }, role: "OWNER" },
      { workspace: { id: "ws_b", name: "Client one" }, role: "MEMBER" },
    ]);

    await expect(listUserWorkspaces("user_1")).resolves.toEqual([
      { id: "ws_a", name: "Agency", role: "OWNER" },
      { id: "ws_b", name: "Client one", role: "MEMBER" },
    ]);
  });

  it("returns an empty list rather than throwing when there are none", async () => {
    mockPrisma.workspaceMember.findMany.mockResolvedValue([]);
    await expect(listUserWorkspaces("user_1")).resolves.toEqual([]);
  });
});
