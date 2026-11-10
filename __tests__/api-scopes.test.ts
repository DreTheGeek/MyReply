/**
 * One scope list for API keys, partner keys, REST and MCP, and the door that
 * enforces it. A scope only ever narrows a role, and a key only counts once a
 * door has let it in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolve, mockConsume } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockConsume: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ resolveRequestApiKey: mockResolve }));
vi.mock("@/lib/api/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api/rate-limit")>()),
  consumeCredentialRequest: mockConsume,
}));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { NextRequest } from "next/server";
import {
  API_SCOPES,
  PARTNER_SCOPES,
  READ_SCOPES,
  WORKSPACE_SCOPES,
  effectiveScopes,
  normalizeScopes,
  scopeCeilingForRole,
} from "../lib/api/scopes";
import { currentCaller } from "../lib/api/caller-context";
import { v1Route } from "../lib/api/v1";
import { MCP_TOOLS, MCP_TOOL_SCOPES, mcpToolsForScopes, runMcpTool } from "../lib/mcp/tools";
import { apiScopesForOAuth } from "../lib/oauth/scopes";

const caller = {
  workspaceId: "ws_1",
  role: "ADMIN" as const,
  apiKeyId: "key_1",
  kind: "workspace" as const,
  partnerId: null,
  scopes: ["campaigns:read" as const],
  credentialId: "key:key_1",
};

function get(path = "/api/v1/campaigns"): NextRequest {
  return new NextRequest(`https://myreply.test${path}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue(caller);
  mockConsume.mockResolvedValue({ status: "allowed", remaining: 100 });
});

describe("the scope list", () => {
  it("keeps partner scopes off every workspace credential", () => {
    expect(WORKSPACE_SCOPES).not.toContain("workspaces:write");
    expect(WORKSPACE_SCOPES).not.toContain("workspaces:read");
    expect(scopeCeilingForRole("OWNER")).not.toContain("workspaces:write");
    expect(PARTNER_SCOPES).toEqual(API_SCOPES);
  });

  it("gives a member the reads and nothing else", () => {
    expect(scopeCeilingForRole("MEMBER")).toEqual(READ_SCOPES);
    expect(READ_SCOPES.every((scope) => scope.endsWith(":read"))).toBe(true);
    expect(scopeCeilingForRole("ADMIN")).toEqual(WORKSPACE_SCOPES);
  });

  it("treats an empty grant as everything the ceiling allows, and otherwise only narrows", () => {
    expect(effectiveScopes([], READ_SCOPES)).toEqual(READ_SCOPES);
    expect(effectiveScopes(["campaigns:write", "campaigns:read"], READ_SCOPES)).toEqual([
      "campaigns:read",
    ]);
    expect(effectiveScopes(["made:up"], WORKSPACE_SCOPES)).toEqual([]);
  });

  it("drops unknown and repeated scopes", () => {
    expect(normalizeScopes(["usage:read", "nope", "usage:read", "accounts:read"])).toEqual([
      "accounts:read",
      "usage:read",
    ]);
  });
});

describe("the v1 door", () => {
  it("runs the handler as the caller it let in", async () => {
    let seen: unknown = "unset";
    const route = v1Route("campaigns:read", async () => {
      seen = currentCaller();
      return new Response("ok");
    });
    const response = await route(get(), { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    expect(seen).toEqual(caller);
    // Nothing leaks past the request.
    expect(currentCaller()).toBeNull();
  });

  it("refuses a key without the endpoint's scope and never runs the handler", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const route = v1Route("campaigns:write", handler);
    const response = await route(get(), { params: Promise.resolve({}) });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a request with no key", async () => {
    mockResolve.mockResolvedValue(null);
    const route = v1Route(null, async () => new Response("ok"));
    expect((await route(get(), { params: Promise.resolve({}) })).status).toBe(401);
  });

  it("answers a plain 500, never the internal error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const route = v1Route("campaigns:read", async () => {
      throw new Error("relation openreply.Secret does not exist at 10.0.0.9");
    });
    const response = await route(get(), { params: Promise.resolve({}) });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("10.0.0.9");
    spy.mockRestore();
  });

  it("passes route params through", async () => {
    const route = v1Route<{ id: string }>("campaigns:read", async (_request, _caller, params) =>
      Response.json(params)
    );
    const response = await route(get("/api/v1/workspaces/ws_9"), {
      params: Promise.resolve({ id: "ws_9" }),
    });
    expect(await response.json()).toEqual({ id: "ws_9" });
  });
});

describe("MCP uses the same scopes", () => {
  it("names a scope for every tool", () => {
    for (const tool of MCP_TOOLS) {
      expect(MCP_TOOL_SCOPES[tool.name], tool.name).toBeDefined();
    }
  });

  it("offers only the tools the scopes cover", () => {
    const names = mcpToolsForScopes(["accounts:read"]).map((tool) => tool.name);
    expect(names).toEqual(["list_instagram_accounts"]);
    expect(mcpToolsForScopes([])).toEqual([]);
  });

  it("refuses a tool the scopes do not cover, even for an admin's key", async () => {
    await expect(
      runMcpTool("create_campaign", { name: "x" }, "ws_1", ["campaigns:read"])
    ).rejects.toThrow(/campaigns:write/);
    await expect(runMcpTool("list_instagram_accounts", {}, "ws_1", ["campaigns:read"])).rejects.toThrow(
      /accounts:read/
    );
  });

  it("maps the two consent scopes onto the API's, cut to the live role", () => {
    expect(apiScopesForOAuth(["mcp:read"], "ADMIN")).toEqual([...READ_SCOPES]);
    expect(apiScopesForOAuth(["mcp:read", "mcp:write"], "ADMIN")).toEqual(
      WORKSPACE_SCOPES.filter((scope) => scope.endsWith(":read") || scope === "campaigns:write")
    );
    // A member who approved write access still cannot write.
    expect(apiScopesForOAuth(["mcp:read", "mcp:write"], "MEMBER")).not.toContain("campaigns:write");
    // Nothing granted, nothing allowed.
    expect(apiScopesForOAuth([], "OWNER")).toEqual([]);
    // The consent screen never promised sending messages.
    expect(apiScopesForOAuth(["mcp:write"], "OWNER")).not.toContain("messages:send");
  });
});
