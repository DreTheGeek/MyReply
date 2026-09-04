import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext, mockSetStarters, mockClearStarters } =
  vi.hoisted(() => ({
    mockPrisma: {
      instagramAccount: { findFirst: vi.fn() },
    },
    mockContext: vi.fn(),
    mockSetStarters: vi.fn(),
    mockClearStarters: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

// The token is opaque to this route, so unwrap it to itself rather than
// standing up a real encryption key.
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (token: string) => token,
}));

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/client")>();
  return {
    ...actual,
    setConversationStarters: mockSetStarters,
    clearConversationStarters: mockClearStarters,
  };
});

import { NextRequest } from "next/server";

import {
  DELETE,
  GET,
  PUT,
} from "../app/api/instagram/conversation-starters/route";

const URL_BASE = "https://myreply.test/api/instagram/conversation-starters";

const OWN_ACCOUNT = {
  id: "account_ours",
  workspaceId: "workspace_123",
  instagramId: "17841400000000000",
  username: "kaldr",
  accessToken: "token_plain",
};

function put(body: unknown) {
  return PUT(
    new NextRequest(URL_BASE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function del(body: unknown) {
  return DELETE(
    new NextRequest(URL_BASE, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function get(instagramAccountId?: string) {
  const url = instagramAccountId
    ? `${URL_BASE}?instagramAccountId=${instagramAccountId}`
    : URL_BASE;
  return GET(new NextRequest(url));
}

function starters(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    question: `Prompt ${index + 1}`,
    payload: `PAYLOAD_${index + 1}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: "workspace_123",
    workspace: { id: "workspace_123" },
    role: "OWNER",
  });
  // Scoping is enforced by the query, so the fixture only matches when the
  // caller's workspace is the one the account belongs to.
  mockPrisma.instagramAccount.findFirst.mockImplementation(
    async ({ where }: { where: { id?: string; workspaceId: string } }) => {
      if (where.workspaceId !== OWN_ACCOUNT.workspaceId) return null;
      if (where.id && where.id !== OWN_ACCOUNT.id) return null;
      return OWN_ACCOUNT;
    }
  );
  mockSetStarters.mockResolvedValue({ result: "success" });
  mockClearStarters.mockResolvedValue({ result: "success" });
});

describe("PUT: validation", () => {
  it("accepts the maximum of four starters", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: starters(4),
    });

    expect(response.status).toBe(200);
    expect(mockSetStarters).toHaveBeenCalledTimes(1);
    const [, instagramId, sent] = mockSetStarters.mock.calls[0];
    expect(instagramId).toBe(OWN_ACCOUNT.instagramId);
    expect(sent).toHaveLength(4);
  });

  it("rejects a fifth starter rather than letting Meta truncate it", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: starters(5),
    });

    expect(response.status).toBe(400);
    expect(mockSetStarters).not.toHaveBeenCalled();
  });

  it("rejects an empty question", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: [{ question: "   ", payload: "GUIDE" }],
    });

    expect(response.status).toBe(400);
    expect(mockSetStarters).not.toHaveBeenCalled();
  });

  it("rejects a question longer than Instagram's 80 characters", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: [{ question: "q".repeat(81), payload: "GUIDE" }],
    });

    expect(response.status).toBe(400);
    expect(mockSetStarters).not.toHaveBeenCalled();
  });

  it("accepts a question of exactly 80 characters", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: [{ question: "q".repeat(80), payload: "GUIDE" }],
    });

    expect(response.status).toBe(200);
  });

  it("rejects a missing payload", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: [{ question: "Send me the guide" }],
    });

    expect(response.status).toBe(400);
    expect(mockSetStarters).not.toHaveBeenCalled();
  });

  it("rejects a payload longer than 1000 characters", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: [{ question: "Send me the guide", payload: "p".repeat(1001) }],
    });

    expect(response.status).toBe(400);
  });

  it("rejects an empty list, because clearing goes through DELETE", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: [],
    });

    expect(response.status).toBe(400);
    expect(mockSetStarters).not.toHaveBeenCalled();
  });

  it("trims what it forwards to Meta", async () => {
    await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: [{ question: "  Send me the guide  ", payload: "  GUIDE  " }],
    });

    expect(mockSetStarters.mock.calls[0][2]).toEqual([
      { question: "Send me the guide", payload: "GUIDE" },
    ]);
  });

  it("surfaces a Meta failure as a 502 rather than a silent success", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSetStarters.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Missing permission")
    );

    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: starters(1),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Missing permission",
    });
  });
});

describe("workspace scoping", () => {
  it("refuses an account id belonging to another workspace", async () => {
    const response = await put({
      instagramAccountId: "account_someone_elses",
      starters: starters(1),
    });

    expect(response.status).toBe(404);
    expect(mockSetStarters).not.toHaveBeenCalled();
  });

  it("scopes the account lookup by workspace, not by id alone", async () => {
    await put({ instagramAccountId: OWN_ACCOUNT.id, starters: starters(1) });

    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: OWN_ACCOUNT.id, workspaceId: "workspace_123" },
    });
  });

  it("does not leak across tenants when the same id exists elsewhere", async () => {
    // Same account row, different caller. The where clause is what stops it.
    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: "workspace_other",
      workspace: { id: "workspace_other" },
      role: "OWNER",
    });

    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: starters(1),
    });

    expect(response.status).toBe(404);
    expect(mockSetStarters).not.toHaveBeenCalled();
  });

  it("refuses the 'all' sentinel instead of guessing an account", async () => {
    const response = await put({
      instagramAccountId: "all",
      starters: starters(1),
    });

    expect(response.status).toBe(400);
    expect(mockSetStarters).not.toHaveBeenCalled();
  });

  it("refuses a DELETE for another workspace's account", async () => {
    const response = await del({ instagramAccountId: "account_someone_elses" });

    expect(response.status).toBe(404);
    expect(mockClearStarters).not.toHaveBeenCalled();
  });

  it("scopes the GET lookup by workspace", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: [] })
    ) as unknown as typeof fetch;

    await get(OWN_ACCOUNT.id);

    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: OWN_ACCOUNT.id, workspaceId: "workspace_123" },
    });
  });
});

describe("role gating", () => {
  it("lets an admin save", async () => {
    mockContext.mockResolvedValue({
      userId: "user_1",
      workspaceId: "workspace_123",
      workspace: { id: "workspace_123" },
      role: "ADMIN",
    });

    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: starters(1),
    });

    expect(response.status).toBe(200);
  });

  it("refuses a member's save before it reaches Meta", async () => {
    mockContext.mockResolvedValue({
      userId: "user_3",
      workspaceId: "workspace_123",
      workspace: { id: "workspace_123" },
      role: "MEMBER",
    });

    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      starters: starters(1),
    });

    expect(response.status).toBe(403);
    expect(mockSetStarters).not.toHaveBeenCalled();
    expect(mockPrisma.instagramAccount.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a member's clear", async () => {
    mockContext.mockResolvedValue({
      userId: "user_3",
      workspaceId: "workspace_123",
      workspace: { id: "workspace_123" },
      role: "MEMBER",
    });

    const response = await del({ instagramAccountId: OWN_ACCOUNT.id });

    expect(response.status).toBe(403);
    expect(mockClearStarters).not.toHaveBeenCalled();
  });

  it("lets a member read the current set", async () => {
    mockContext.mockResolvedValue({
      userId: "user_3",
      workspaceId: "workspace_123",
      workspace: { id: "workspace_123" },
      role: "MEMBER",
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: [] })
    ) as unknown as typeof fetch;

    const response = await get(OWN_ACCOUNT.id);
    expect(response.status).toBe(200);
  });

  it("rejects an unauthenticated caller on every verb", async () => {
    mockContext.mockResolvedValue(null);

    expect((await get(OWN_ACCOUNT.id)).status).toBe(401);
    expect(
      (await put({ instagramAccountId: OWN_ACCOUNT.id, starters: starters(1) }))
        .status
    ).toBe(401);
    expect((await del({ instagramAccountId: OWN_ACCOUNT.id })).status).toBe(401);
  });
});

describe("DELETE", () => {
  it("clears the whole set for an account in the workspace", async () => {
    const response = await del({ instagramAccountId: OWN_ACCOUNT.id });

    expect(response.status).toBe(200);
    expect(mockClearStarters).toHaveBeenCalledWith(
      "token_plain",
      OWN_ACCOUNT.instagramId
    );
  });

  it("requires an account id", async () => {
    const response = await del({});

    expect(response.status).toBe(400);
    expect(mockClearStarters).not.toHaveBeenCalled();
  });
});

describe("GET: reading the live set", () => {
  it("returns the starters Meta reports, flattened out of the field wrapper", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        data: [
          {
            ice_breakers: [{ question: "Send me the guide", payload: "GUIDE" }],
          },
        ],
      })
    ) as unknown as typeof fetch;

    const response = await get(OWN_ACCOUNT.id);
    const payload = await response.json();

    expect(payload.data.readable).toBe(true);
    expect(payload.data.starters).toEqual([
      { question: "Send me the guide", payload: "GUIDE" },
    ]);
  });

  it("unwraps the per-locale call_to_actions shape as well", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        data: [
          {
            ice_breakers: [
              {
                locale: "default",
                call_to_actions: [{ question: "Pricing?", payload: "PRICING" }],
              },
            ],
          },
        ],
      })
    ) as unknown as typeof fetch;

    const payload = await (await get(OWN_ACCOUNT.id)).json();
    expect(payload.data.starters).toEqual([
      { question: "Pricing?", payload: "PRICING" },
    ]);
  });

  it("reports readable false when Meta refuses the read", async () => {
    // An empty list here would read as "none configured", which is a different
    // and much more damaging claim than "we could not tell".
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { message: "nope", code: 100 } }, { status: 400 })
    ) as unknown as typeof fetch;

    const payload = await (await get(OWN_ACCOUNT.id)).json();
    expect(payload.data.readable).toBe(false);
    expect(payload.data.starters).toEqual([]);
  });

  it("reports a 400 when the workspace has no connected account", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);

    const response = await get();
    expect(response.status).toBe(400);
  });
});
