/**
 * The Instagram connect callback, when the connection fails.
 *
 * The internal reason (a token exchange response, a Graph error) must stay
 * server side. It used to ride on the redirect URL and be printed on the
 * settings page.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockAuth, mockCompleteConnection } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceMember: { findFirst: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockCompleteConnection: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/channels/registry", () => ({
  getChannelAdapter: () => ({
    platform: "INSTAGRAM",
    auth: { completeConnection: mockCompleteConnection },
  }),
}));

import { NextRequest } from "next/server";
import { GET } from "../app/api/instagram/callback/route";
import { createOAuthState } from "../lib/security/oauth-state";

const SECRET_DETAIL = "Token exchange failed: client_secret mismatch for app 123";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-for-the-callback-test");
  vi.stubEnv("NEXTAUTH_URL", "https://myreply.test");
  mockAuth.mockResolvedValue({ user: { id: "user_1" } });
  mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "OWNER" });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockCompleteConnection.mockRejectedValue(new Error(SECRET_DETAIL));
});

describe("GET /api/instagram/callback, when connecting fails", () => {
  it("redirects without the internal reason", async () => {
    const state = createOAuthState("workspace_1");
    const response = await GET(
      new NextRequest(
        `https://myreply.test/api/instagram/callback?code=abc&state=${encodeURIComponent(state)}`
      )
    );

    const location = response.headers.get("location") ?? "";
    expect(location).toBe("https://myreply.test/settings?instagram=failed");
    expect(location).not.toContain("reason");
    expect(decodeURIComponent(location)).not.toContain("client_secret");
  });

  it("still records the reason where an operator can read it", async () => {
    const state = createOAuthState("workspace_1");
    await GET(
      new NextRequest(
        `https://myreply.test/api/instagram/callback?code=abc&state=${encodeURIComponent(state)}`
      )
    );

    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        message: "Instagram connection failed",
        payload: { reason: SECRET_DETAIL },
      }),
    });
  });
});
