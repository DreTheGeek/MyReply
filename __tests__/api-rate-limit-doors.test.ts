/**
 * The limit at the two doors: the v1 key guard and the MCP endpoint.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConsume, mockApiKeyContext, mockAuthenticateMcp } = vi.hoisted(
  () => ({
    mockConsume: vi.fn(),
    mockApiKeyContext: vi.fn(),
    mockAuthenticateMcp: vi.fn(),
  })
);

vi.mock("@/lib/api/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api/rate-limit")>()),
  consumeCredentialRequest: mockConsume,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestApiKey: mockApiKeyContext,
  requestCarriesPartnerKey: async () => false,
  resolveRequestPartner: async () => null,
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-auth", () => ({
  authenticateMcpRequest: mockAuthenticateMcp,
  insufficientScopeResponse: vi.fn(),
  toolNeedsWriteScope: () => false,
}));

vi.mock("@/lib/mcp/tools", () => ({
  MCP_TOOLS: [],
  mcpToolsForScopes: () => [],
  runMcpTool: vi.fn(),
}));

import { NextRequest } from "next/server";
import { isRejection, requireApiKey } from "../lib/api/v1";
import { POST as mcpPost } from "../app/api/mcp/route";

function rpc(body: unknown): NextRequest {
  return new NextRequest("https://myreply.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiKeyContext.mockResolvedValue({
    workspaceId: "ws_1",
    role: "ADMIN",
    apiKeyId: "key_1",
    kind: "workspace",
    partnerId: null,
    scopes: ["campaigns:read"],
    credentialId: "key:key_1",
  });
  mockAuthenticateMcp.mockResolvedValue({
    ok: true,
    credential: {
      kind: "api_key",
      credentialId: "key:key_1",
      workspaceId: "ws_1",
      role: "ADMIN",
      scopes: null,
      apiScopes: [],
    },
  });
  mockConsume.mockResolvedValue({ status: "allowed", remaining: 119 });
});

describe("v1 key guard", () => {
  it("lets an allowed key through and counts it once, by key id", async () => {
    const caller = await requireApiKey();
    expect(isRejection(caller)).toBe(false);
    expect(mockConsume).toHaveBeenCalledTimes(1);
    expect(mockConsume).toHaveBeenCalledWith("key:key_1");
  });

  it("refuses a key over its allowance with 429 and Retry-After", async () => {
    mockConsume.mockResolvedValue({ status: "limited", retryAfterSeconds: 12 });
    const caller = await requireApiKey();
    expect(isRejection(caller)).toBe(true);
    if (!isRejection(caller)) return;
    expect(caller.status).toBe(429);
    expect(caller.headers.get("retry-after")).toBe("12");
  });

  it("refuses with 503 when the limiter is unavailable", async () => {
    mockConsume.mockResolvedValue({ status: "unavailable" });
    const caller = await requireApiKey();
    expect(isRejection(caller) && caller.status).toBe(503);
  });

  it("refuses a key without the scope the endpoint needs, after counting it", async () => {
    const caller = await requireApiKey("campaigns:write");
    expect(isRejection(caller) && caller.status).toBe(403);
    if (!isRejection(caller)) return;
    expect((await caller.json()).error).toMatch(/campaigns:write/);
  });

  it("lets a key through when it holds the scope", async () => {
    expect(isRejection(await requireApiKey("campaigns:read"))).toBe(false);
  });

  it("never counts a request that presented no key", async () => {
    mockApiKeyContext.mockResolvedValue(null);
    const caller = await requireApiKey();
    expect(isRejection(caller) && caller.status).toBe(401);
    expect(mockConsume).not.toHaveBeenCalled();
  });
});

describe("MCP endpoint", () => {
  it("refuses a credential over its allowance before running anything", async () => {
    mockConsume.mockResolvedValue({ status: "limited", retryAfterSeconds: 30 });
    const response = await mcpPost(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(mockConsume).toHaveBeenCalledWith("key:key_1");
  });

  it("refuses with 503 when the limiter is unavailable", async () => {
    mockConsume.mockResolvedValue({ status: "unavailable" });
    const response = await mcpPost(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(response.status).toBe(503);
  });

  it("negotiates a supported protocol revision and falls back to the newest", async () => {
    const asked = await mcpPost(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })
    );
    expect((await asked.json()).result.protocolVersion).toBe("2025-03-26");

    const unknown = await mcpPost(
      rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })
    );
    expect((await unknown.json()).result.protocolVersion).toBe("2025-11-25");
  });
});
