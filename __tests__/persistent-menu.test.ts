import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext, mockSetMenu, mockClearMenu } = vi.hoisted(
  () => ({
    mockPrisma: {
      instagramAccount: { findFirst: vi.fn() },
    },
    mockContext: vi.fn(),
    mockSetMenu: vi.fn(),
    mockClearMenu: vi.fn(),
  })
);

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

vi.mock("@/lib/meta/persistent-menu", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/persistent-menu")>();
  return {
    ...actual,
    setPersistentMenu: mockSetMenu,
    clearPersistentMenu: mockClearMenu,
  };
});

import { NextRequest } from "next/server";

// getPersistentMenu and toPersistentMenuItems come through the partial mock
// untouched. The two writers are stubbed above for the route tests, so the
// tests that exercise the real request shape reach for the unmocked module.
import {
  getPersistentMenu,
  toPersistentMenuItems,
  MAX_PERSISTENT_MENU_ITEMS,
  type PersistentMenuItem,
} from "../lib/meta/persistent-menu";

const realMenuModule = await vi.importActual<
  typeof import("@/lib/meta/persistent-menu")
>("@/lib/meta/persistent-menu");
import { DELETE, GET, PUT } from "../app/api/instagram/persistent-menu/route";

const URL_BASE = "https://myreply.test/api/instagram/persistent-menu";

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

function items(count: number): PersistentMenuItem[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "postback" as const,
    title: `Item ${index + 1}`,
    payload: `reveal:auto_${index + 1}`,
  }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  mockSetMenu.mockResolvedValue({ result: "success" });
  mockClearMenu.mockResolvedValue({ result: "success" });
});

describe("PUT: validation", () => {
  it("accepts the recommended maximum of five items", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: items(MAX_PERSISTENT_MENU_ITEMS),
    });

    expect(response.status).toBe(200);
    const [, instagramId, sent] = mockSetMenu.mock.calls[0];
    expect(instagramId).toBe(OWN_ACCOUNT.instagramId);
    expect(sent).toHaveLength(5);
  });

  it("rejects a sixth item rather than letting Meta decide", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: items(MAX_PERSISTENT_MENU_ITEMS + 1),
    });

    expect(response.status).toBe(400);
    expect(mockSetMenu).not.toHaveBeenCalled();
  });

  it("rejects an empty list, because clearing goes through DELETE", async () => {
    const response = await put({ instagramAccountId: OWN_ACCOUNT.id, items: [] });

    expect(response.status).toBe(400);
    expect(mockSetMenu).not.toHaveBeenCalled();
  });

  it("rejects an empty label", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: [{ type: "postback", title: "   ", payload: "reveal:auto_1" }],
    });

    expect(response.status).toBe(400);
  });

  it("rejects a label longer than thirty characters", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: [{ type: "postback", title: "t".repeat(31), payload: "GO" }],
    });

    expect(response.status).toBe(400);
  });

  it("rejects a postback item with no payload", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: [{ type: "postback", title: "Pricing" }],
    });

    expect(response.status).toBe(400);
  });

  it("accepts a link item", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: [
        { type: "web_url", title: "Book a call", url: "https://kaldr.test/book" },
      ],
    });

    expect(response.status).toBe(200);
    expect(mockSetMenu.mock.calls[0][2]).toEqual([
      { type: "web_url", title: "Book a call", url: "https://kaldr.test/book" },
    ]);
  });

  it("rejects a plain http link, which Instagram will not open", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: [
        { type: "web_url", title: "Book a call", url: "http://kaldr.test/book" },
      ],
    });

    expect(response.status).toBe(400);
    expect(mockSetMenu).not.toHaveBeenCalled();
  });

  it("rejects an item type Instagram has no button for", async () => {
    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: [{ type: "phone_number", title: "Call", payload: "+1" }],
    });

    expect(response.status).toBe(400);
  });

  it("trims what it forwards to Meta", async () => {
    await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: [{ type: "postback", title: "  Pricing  ", payload: "  GO  " }],
    });

    expect(mockSetMenu.mock.calls[0][2]).toEqual([
      { type: "postback", title: "Pricing", payload: "GO" },
    ]);
  });

  it("surfaces a Meta failure as a 502 rather than a silent success", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    mockSetMenu.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Missing permission")
    );

    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: items(1),
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
      items: items(1),
    });

    expect(response.status).toBe(404);
    expect(mockSetMenu).not.toHaveBeenCalled();
  });

  it("scopes the account lookup by workspace, not by id alone", async () => {
    await put({ instagramAccountId: OWN_ACCOUNT.id, items: items(1) });

    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: OWN_ACCOUNT.id, workspaceId: "workspace_123" },
    });
  });

  it("does not leak across tenants when the same id exists elsewhere", async () => {
    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: "workspace_other",
      workspace: { id: "workspace_other" },
      role: "OWNER",
    });

    const response = await put({
      instagramAccountId: OWN_ACCOUNT.id,
      items: items(1),
    });

    expect(response.status).toBe(404);
    expect(mockSetMenu).not.toHaveBeenCalled();
  });

  it("refuses the 'all' sentinel on a write instead of guessing an account", async () => {
    const response = await put({ instagramAccountId: "all", items: items(1) });

    expect(response.status).toBe(400);
    expect(mockSetMenu).not.toHaveBeenCalled();
  });

  it("refuses the 'all' sentinel on a clear as well", async () => {
    const response = await del({ instagramAccountId: "all" });

    expect(response.status).toBe(400);
    expect(mockClearMenu).not.toHaveBeenCalled();
  });

  it("refuses a DELETE for another workspace's account", async () => {
    const response = await del({ instagramAccountId: "account_someone_elses" });

    expect(response.status).toBe(404);
    expect(mockClearMenu).not.toHaveBeenCalled();
  });

  it("scopes the GET lookup by workspace", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ data: [] })
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
      items: items(1),
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
      items: items(1),
    });

    expect(response.status).toBe(403);
    expect(mockSetMenu).not.toHaveBeenCalled();
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
    expect(mockClearMenu).not.toHaveBeenCalled();
  });

  it("lets a member read the current menu", async () => {
    mockContext.mockResolvedValue({
      userId: "user_3",
      workspaceId: "workspace_123",
      workspace: { id: "workspace_123" },
      role: "MEMBER",
    });
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ data: [] })
    ) as unknown as typeof fetch;

    const response = await get(OWN_ACCOUNT.id);
    expect(response.status).toBe(200);
  });

  it("rejects an unauthenticated caller on every verb", async () => {
    mockContext.mockResolvedValue(null);

    expect((await get(OWN_ACCOUNT.id)).status).toBe(401);
    expect(
      (await put({ instagramAccountId: OWN_ACCOUNT.id, items: items(1) })).status
    ).toBe(401);
    expect((await del({ instagramAccountId: OWN_ACCOUNT.id })).status).toBe(401);
  });
});

describe("DELETE", () => {
  it("clears the whole menu for an account in the workspace", async () => {
    const response = await del({ instagramAccountId: OWN_ACCOUNT.id });

    expect(response.status).toBe(200);
    expect(mockClearMenu).toHaveBeenCalledWith(
      "token_plain",
      OWN_ACCOUNT.instagramId
    );
  });

  it("requires an account id", async () => {
    const response = await del({});

    expect(response.status).toBe(400);
    expect(mockClearMenu).not.toHaveBeenCalled();
  });
});

describe("GET: reading the live menu", () => {
  it("returns the items Meta reports, out of the per-locale wrapper", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            persistent_menu: [
              {
                locale: "default",
                call_to_actions: [
                  { type: "postback", title: "Pricing", payload: "PRICING" },
                  {
                    type: "web_url",
                    title: "Book",
                    url: "https://kaldr.test/book",
                  },
                ],
              },
            ],
          },
        ],
      })
    ) as unknown as typeof fetch;

    const payload = await (await get(OWN_ACCOUNT.id)).json();

    expect(payload.data.readable).toBe(true);
    expect(payload.data.items).toEqual([
      { type: "postback", title: "Pricing", payload: "PRICING" },
      { type: "web_url", title: "Book", url: "https://kaldr.test/book" },
    ]);
  });

  it("reports readable false when Meta refuses the read", async () => {
    // An empty list here would read as "no menu configured", which is a very
    // different and much more damaging claim than "we could not tell".
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: "nope", code: 100 } }, 400)
    ) as unknown as typeof fetch;

    const payload = await (await get(OWN_ACCOUNT.id)).json();
    expect(payload.data.readable).toBe(false);
    expect(payload.data.items).toEqual([]);
  });

  it("reports a 400 when the workspace has no connected account", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);

    const response = await get();
    expect(response.status).toBe(400);
  });
});

describe("the Meta calls themselves", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ result: "success" })
    ) as unknown as typeof fetch;
  });

  function lastCall(): [string, RequestInit] {
    const calls = (
      globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const call = calls[calls.length - 1];
    return [String(call[0]), call[1] as RequestInit];
  }

  it("posts the menu under a default locale, on the instagram platform", async () => {
    await realMenuModule.setPersistentMenu("token", "ig_1", [
      { type: "postback", title: "Pricing", payload: "PRICING" },
    ]);

    const [url, init] = lastCall();
    expect(url).toContain("/ig_1/messenger_profile");
    const body = JSON.parse(String(init.body));
    expect(body.platform).toBe("instagram");
    expect(body.persistent_menu).toEqual([
      {
        locale: "default",
        call_to_actions: [
          { type: "postback", title: "Pricing", payload: "PRICING" },
        ],
      },
    ]);
    // Messenger-only fields that Instagram rejects.
    expect(JSON.stringify(body)).not.toContain("composer_input_disabled");
    expect(JSON.stringify(body)).not.toContain("webview_height_ratio");
  });

  it("caps the menu at five items and truncates a long label", async () => {
    await realMenuModule.setPersistentMenu("token", "ig_1", [
      ...items(6),
      { type: "postback", title: "t".repeat(40), payload: "GO" },
    ]);

    const body = JSON.parse(String(lastCall()[1].body));
    expect(body.persistent_menu[0].call_to_actions).toHaveLength(5);
    expect(
      body.persistent_menu[0].call_to_actions.every(
        (action: { title: string }) => action.title.length <= 30
      )
    ).toBe(true);
  });

  it("clears by deleting the field, not by writing an empty menu", async () => {
    await realMenuModule.clearPersistentMenu("token", "ig_1");

    const [url, init] = lastCall();
    expect(init.method).toBe("DELETE");
    expect(url).toContain("platform=instagram");
    expect(decodeURIComponent(url)).toContain('["persistent_menu"]');
  });

  it("reads back null when the response is not the shape we expect", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ unexpected: true })
    ) as unknown as typeof fetch;

    await expect(getPersistentMenu("token", "ig_1")).resolves.toBeNull();
  });

  it("drops an item Meta reports that we could not render back", async () => {
    expect(
      toPersistentMenuItems([
        { type: "postback", title: "Ok", payload: "GO" },
        { type: "postback", title: "No payload" },
        { type: "web_url", title: "No url" },
        { type: "nested_menu", title: "Unsupported" },
      ])
    ).toEqual([{ type: "postback", title: "Ok", payload: "GO" }]);
  });
});
