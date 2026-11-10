import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext, mockAnnounce } = vi.hoisted(() => ({
  mockAnnounce: vi.fn(),
  mockPrisma: {
    instagramAccount: { deleteMany: vi.fn(), findFirst: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/webhooks/account-events", () => ({ announceDisconnected: mockAnnounce }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { POST } from "../app/api/instagram/disconnect/route";

function post(body: unknown, { raw = false } = {}) {
  return new Request("https://reply.example.com/api/instagram/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockContext.mockResolvedValue({
    workspaceId: "workspace_1",
    role: "OWNER",
    userId: "user_1",
  });
  mockPrisma.instagramAccount.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ platform: "INSTAGRAM" });
  mockAnnounce.mockResolvedValue(undefined);
  mockPrisma.operationalEvent.create.mockResolvedValue({});
});

describe("POST /api/instagram/disconnect", () => {
  // The route used to spread the id in conditionally, so a body that did not
  // carry one widened the delete to every account in the workspace and the
  // cascades took the campaigns and the whole delivery history with them.
  it("refuses a request with no account id instead of deleting every account", async () => {
    const response = await POST(post({}));

    expect(response.status).toBe(400);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses a non-string account id", async () => {
    const response = await POST(post({ instagramAccountId: 12345 }));

    expect(response.status).toBe(400);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses an unparseable body", async () => {
    const response = await POST(post("not json at all", { raw: true }));

    expect(response.status).toBe(400);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes exactly one account, keyed on both id and workspace", async () => {
    const response = await POST(post({ instagramAccountId: "account_1" }));

    expect(response.status).toBe(200);
    expect(mockPrisma.instagramAccount.deleteMany).toHaveBeenCalledWith({
      where: { id: "account_1", workspaceId: "workspace_1" },
    });
  });

  it("reports 404 rather than success when the account is another tenant's", async () => {
    mockPrisma.instagramAccount.deleteMany.mockResolvedValue({ count: 0 });

    const response = await POST(post({ instagramAccountId: "someone_elses" }));

    expect(response.status).toBe(404);
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("records who disconnected what, since the campaigns go with it", async () => {
    await POST(post({ instagramAccountId: "account_1" }));

    // Written through the shared recordAuditEvent helper, which every
    // destructive route now uses, so the shape is the same everywhere.
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace_1",
          message: "instagram_account.disconnected",
          payload: expect.objectContaining({
            actorUserId: "user_1",
            targetId: "account_1",
          }),
        }),
      })
    );
  });

  it("still reports success when only the audit write fails", async () => {
    // The account is already gone by then. Failing here would tell the caller
    // the disconnect did not happen, which is the worse lie.
    mockPrisma.operationalEvent.create.mockRejectedValue(new Error("db down"));

    const response = await POST(post({ instagramAccountId: "account_1" }));

    expect(response.status).toBe(200);
  });

  it("refuses a member who cannot manage the workspace", async () => {
    mockContext.mockResolvedValue({
      workspaceId: "workspace_1",
      role: "MEMBER",
      userId: "user_2",
    });

    const response = await POST(post({ instagramAccountId: "account_1" }));

    expect(response.status).toBe(403);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("tells listening partner apps the account is gone, only when it was this workspace's", async () => {
    await POST(post({ instagramAccountId: "acct_1" }));
    expect(mockAnnounce).toHaveBeenCalledWith(
      [{ id: "acct_1", workspaceId: "workspace_1" }],
      "INSTAGRAM",
      "disconnected"
    );

    mockAnnounce.mockClear();
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    mockPrisma.instagramAccount.deleteMany.mockResolvedValue({ count: 0 });
    await POST(post({ instagramAccountId: "theirs" }));
    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});
