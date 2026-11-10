/**
 * Storing connected accounts, and the generic connect routes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockCanConnect, mockContext } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  },
  mockCanConnect: vi.fn(),
  mockContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/instagram-accounts", () => ({ canConnectInstagramAccount: mockCanConnect }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import type { ChannelAdapter } from "../lib/channels/adapter";
import { storeConnectedAccounts } from "../lib/channels/connect";
import { GET as connect } from "../app/api/channels/[platform]/connect/route";

const subscribe = vi.fn();
const adapter = {
  platform: "FACEBOOK",
  auth: { subscribeToEvents: subscribe },
} as unknown as ChannelAdapter;

const grant = (id: string) => ({
  externalId: id,
  username: `Page ${id}`,
  name: `Page ${id}`,
  accessToken: `token_${id}`,
  expiresAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  vi.stubEnv("NEXTAUTH_URL", "https://myreply.test");
  mockCanConnect.mockResolvedValue({ allowed: true, reason: null });
  mockPrisma.instagramAccount.findUnique.mockResolvedValue(null);
  mockPrisma.instagramAccount.create.mockResolvedValue({});
  subscribe.mockResolvedValue(true);
});

describe("storeConnectedAccounts", () => {
  it("stores every granted Page, encrypted and on its platform", async () => {
    const result = await storeConnectedAccounts({ adapter, grants: [grant("p1"), grant("p2")], workspaceId: "ws_1" });
    expect(result).toEqual({ connected: 2, refused: null });
    const data = mockPrisma.instagramAccount.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ workspaceId: "ws_1", instagramId: "p1", platform: "FACEBOOK", webhookSubscribed: true });
    // Never the plaintext token.
    expect(data.accessToken).not.toContain("token_p1");
  });

  it("refuses an account held by another workspace or past the plan, and stores the rest", async () => {
    mockCanConnect
      .mockResolvedValueOnce({ allowed: false, reason: "already_connected" })
      .mockResolvedValueOnce({ allowed: true, reason: null });
    const result = await storeConnectedAccounts({ adapter, grants: [grant("p1"), grant("p2")], workspaceId: "ws_1" });
    expect(result).toEqual({ connected: 1, refused: "already_connected" });
  });

  it("never moves an existing row across workspaces or platforms", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({ id: "row_1" });
    mockPrisma.instagramAccount.updateMany.mockResolvedValue({ count: 0 });
    const result = await storeConnectedAccounts({ adapter, grants: [grant("p1")], workspaceId: "ws_1" });
    expect(mockPrisma.instagramAccount.updateMany.mock.calls[0][0].where).toEqual({
      id: "row_1", workspaceId: "ws_1", platform: "FACEBOOK",
    });
    expect(result).toEqual({ connected: 0, refused: "already_connected" });
  });

  it("records who granted the connection, and keeps it when a reconnect cannot say", async () => {
    await storeConnectedAccounts({
      adapter,
      grants: [{ ...grant("p1"), authorizedByExternalId: "asid_1" }],
      workspaceId: "ws_1",
    });
    expect(mockPrisma.instagramAccount.create.mock.calls[0][0].data.authorizedByExternalId).toBe("asid_1");

    mockPrisma.instagramAccount.findUnique.mockResolvedValue({ id: "row_1" });
    mockPrisma.instagramAccount.updateMany.mockResolvedValue({ count: 1 });
    await storeConnectedAccounts({ adapter, grants: [grant("p1")], workspaceId: "ws_1" });
    expect(mockPrisma.instagramAccount.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      "authorizedByExternalId"
    );
  });

  it("still connects when the event subscription fails, recorded as not subscribed", async () => {
    subscribe.mockRejectedValue(new Error("boom"));
    await storeConnectedAccounts({ adapter, grants: [grant("p1")], workspaceId: "ws_1" });
    expect(mockPrisma.instagramAccount.create.mock.calls[0][0].data.webhookSubscribed).toBe(false);
  });

  it("says nothing was granted when the list is empty", async () => {
    await expect(storeConnectedAccounts({ adapter, grants: [], workspaceId: "ws_1" })).resolves.toEqual({
      connected: 0, refused: "none_granted",
    });
  });
});

describe("GET /api/channels/[platform]/connect", () => {
  const call = (platform: string) =>
    connect(new Request("https://myreply.test/x"), { params: Promise.resolve({ platform }) });

  it("404s a platform that does not use the generic flow", async () => {
    expect((await call("instagram")).status).toBe(404);
    expect((await call("myspace")).status).toBe(404);
  });

  it("refuses a member", async () => {
    mockContext.mockResolvedValue({ workspaceId: "ws_1", role: "MEMBER" });
    expect((await call("facebook")).headers.get("location")).toBe("https://myreply.test/settings?facebook=forbidden");
  });

  it("says so when the deployment has no Facebook app configured", async () => {
    mockContext.mockResolvedValue({ workspaceId: "ws_1", role: "OWNER" });
    vi.stubEnv("FACEBOOK_APP_ID", "");
    expect((await call("facebook")).headers.get("location")).toBe("https://myreply.test/settings?facebook=misconfigured");
  });

  it("sends an owner to Facebook's dialog with a signed state", async () => {
    mockContext.mockResolvedValue({ workspaceId: "ws_1", role: "OWNER" });
    vi.stubEnv("FACEBOOK_APP_ID", "app_1");
    vi.stubEnv("FACEBOOK_APP_SECRET", "secret");
    vi.stubEnv("NEXTAUTH_SECRET", "a-long-enough-test-secret");
    const location = new URL((await call("facebook")).headers.get("location") ?? "");
    expect(location.hostname).toBe("www.facebook.com");
    expect(location.searchParams.get("client_id")).toBe("app_1");
    expect(location.searchParams.get("redirect_uri")).toBe("https://myreply.test/api/channels/facebook/callback");
    expect(location.searchParams.get("scope")).toContain("pages_messaging");
    expect(location.searchParams.get("state")).toMatch(/\./);
  });
});
