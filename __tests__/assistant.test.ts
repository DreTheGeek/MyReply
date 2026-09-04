import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockContext,
  mockGetCredential,
  mockTouch,
  mockRunMcpTool,
  mockCallProvider,
  mockPrisma,
} = vi.hoisted(() => ({
  mockContext: vi.fn(),
  mockGetCredential: vi.fn(),
  mockTouch: vi.fn(),
  mockRunMcpTool: vi.fn(),
  mockCallProvider: vi.fn(),
  mockPrisma: {},
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/tracking/server", () => ({
  generateTrackedLinkSlug: () => "slug123",
}));
vi.mock("@/lib/reports/share", () => ({
  generateReportShareSlug: () => "report123",
}));
vi.mock("@/lib/tracking/message", () => ({
  buildTrackedUrl: (slug: string) => `https://x/r/${slug}`,
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string): boolean => role !== "MEMBER",
}));

vi.mock("@/lib/ai/workspace-key", () => ({
  getWorkspaceAiCredential: mockGetCredential,
  touchWorkspaceAiKey: mockTouch,
}));

// The real tool definitions, a stubbed executor. The assistant must drive the
// same seven tools the public MCP endpoint exposes, so MCP_TOOLS stays real.
vi.mock("@/lib/mcp/tools", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/mcp/tools")>("../lib/mcp/tools");
  return {
    MCP_TOOLS: actual.MCP_TOOLS,
    mcpToolsForRole: actual.mcpToolsForRole,
    runMcpTool: mockRunMcpTool,
  };
});

// The provider HTTP call is stubbed everywhere. Nothing in this suite goes out
// to a network, and no fixture holds anything key-shaped.
vi.mock("@/lib/ai/client", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/ai/client")>("../lib/ai/client");
  return { ...actual, callProvider: mockCallProvider };
});

import { NextRequest } from "next/server";

import { MCP_TOOLS, mcpToolsForRole } from "../lib/mcp/tools";
import {
  MAX_INPUT_MESSAGES,
  MAX_TOOL_ITERATIONS,
  buildSystemPrompt,
  runAssistant,
  sanitizeToolArgs,
} from "../lib/ai/assistant";
import type { AiTurn } from "../lib/ai/client";
import { ProviderError } from "../lib/ai/client";
import {
  ASSISTANT_WINDOWS,
  checkAssistantRateLimit,
  resetAssistantRateLimit,
} from "../lib/ai/rate-limit";
import { POST } from "../app/api/assistant/route";

const URL_BASE = "https://myreply.test/api/assistant";
const SESSION_WORKSPACE = "workspace_ours";
const OTHER_WORKSPACE = "workspace_theirs";

/** Obviously fake. Never put a plausible provider key in a fixture. */
const FAKE_KEY = "not-a-real-key-000000000000000000";

function textTurn(text: string): AiTurn {
  return {
    message: { role: "assistant", text, toolCalls: [], toolResults: [] },
    stopReason: "end_turn",
  };
}

function toolTurn(
  name: string,
  input: Record<string, unknown>,
  id = "call_1"
): AiTurn {
  return {
    message: {
      role: "assistant",
      text: "",
      toolCalls: [{ id, name, input }],
      toolResults: [],
    },
    stopReason: "tool_use",
  };
}

function ask(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAssistantRateLimit();

  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: SESSION_WORKSPACE,
    workspace: { id: SESSION_WORKSPACE, name: "Ours" },
    role: "OWNER",
  });
  mockGetCredential.mockResolvedValue({
    provider: "ANTHROPIC",
    model: "claude-opus-5",
    apiKey: FAKE_KEY,
  });
  mockRunMcpTool.mockResolvedValue({ campaigns: [] });
  mockCallProvider.mockResolvedValue(textTurn("Done."));
});

describe("sanitizeToolArgs", () => {
  it("drops every argument that could name a tenant", () => {
    const clean = sanitizeToolArgs({
      workspaceId: OTHER_WORKSPACE,
      workspace_id: OTHER_WORKSPACE,
      workspace: OTHER_WORKSPACE,
      tenantId: OTHER_WORKSPACE,
      id: "camp_1",
      isActive: false,
    });
    expect(clean).toEqual({ id: "camp_1", isActive: false });
  });
});

describe("buildSystemPrompt", () => {
  it("names the product, scopes it to one workspace and asks for the numbers first", () => {
    const prompt = buildSystemPrompt("Ours");
    expect(prompt).toContain("Ask MyReply");
    expect(prompt).toContain("one workspace");
    expect(prompt).toContain('"Ours"');
    expect(prompt).toContain("get_campaign_performance");
    expect(prompt).toContain("owner's voice");
  });

  it("works without a workspace name", () => {
    expect(buildSystemPrompt()).toContain("Ask MyReply");
  });
});

describe("runAssistant tool loop", () => {
  it("hands tools the session workspace, never the model's", async () => {
    const runTool = vi.fn().mockResolvedValue({ ok: true });
    const callModel = vi
      .fn()
      .mockResolvedValueOnce(
        toolTurn("update_campaign", {
          workspaceId: OTHER_WORKSPACE,
          id: "camp_1",
          isActive: false,
        })
      )
      .mockResolvedValueOnce(textTurn("Paused it."));

    const result = await runAssistant({
      workspaceId: SESSION_WORKSPACE,
      role: "OWNER",
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: FAKE_KEY,
      messages: [
        { role: "user", text: "pause it", toolCalls: [], toolResults: [] },
      ],
      runTool,
      callModel,
    });

    expect(runTool).toHaveBeenCalledTimes(1);
    const [name, args, workspaceId] = runTool.mock.calls[0];
    expect(name).toBe("update_campaign");
    expect(workspaceId).toBe(SESSION_WORKSPACE);
    expect(args).not.toHaveProperty("workspaceId");
    expect(JSON.stringify(args)).not.toContain(OTHER_WORKSPACE);
    expect(result.message).toBe("Paused it.");
  });

  it("refuses to execute a tool that is not one of ours", async () => {
    const runTool = vi.fn();
    const callModel = vi
      .fn()
      .mockResolvedValueOnce(toolTurn("drop_everything", {}))
      .mockResolvedValueOnce(textTurn("I cannot do that."));

    const result = await runAssistant({
      workspaceId: SESSION_WORKSPACE,
      role: "OWNER",
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: FAKE_KEY,
      messages: [{ role: "user", text: "go", toolCalls: [], toolResults: [] }],
      runTool,
      callModel,
    });

    expect(runTool).not.toHaveBeenCalled();
    expect(result.toolEvents[0]).toMatchObject({
      name: "drop_everything",
      ok: false,
    });
  });

  it("feeds a tool failure back instead of throwing", async () => {
    const runTool = vi
      .fn()
      .mockRejectedValue(new Error("Unknown campaign for this workspace"));
    const callModel = vi
      .fn()
      .mockResolvedValueOnce(toolTurn("get_campaign_performance", { id: "x" }))
      .mockResolvedValueOnce(textTurn("That campaign does not exist."));

    const result = await runAssistant({
      workspaceId: SESSION_WORKSPACE,
      role: "OWNER",
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: FAKE_KEY,
      messages: [{ role: "user", text: "how is x", toolCalls: [], toolResults: [] }],
      runTool,
      callModel,
    });

    // The loop passes one growing array, so read the turn that carries results
    // rather than assuming it is still last by the time the run finishes.
    const conversation = callModel.mock.calls[1][0].messages;
    const withResults = conversation.find(
      (message: { toolResults: unknown[] }) => message.toolResults.length > 0
    );
    expect(withResults.toolResults[0].isError).toBe(true);
    expect(withResults.toolResults[0].content).toContain("Unknown campaign");
    expect(result.toolEvents[0].ok).toBe(false);
  });

  it("stops at the iteration cap when the model will not stop", async () => {
    const runTool = vi.fn().mockResolvedValue({ campaigns: [] });
    const callModel = vi
      .fn()
      .mockResolvedValue(toolTurn("list_campaigns", {}));

    const result = await runAssistant({
      workspaceId: SESSION_WORKSPACE,
      role: "OWNER",
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: FAKE_KEY,
      messages: [{ role: "user", text: "loop", toolCalls: [], toolResults: [] }],
      runTool,
      callModel,
    });

    expect(callModel).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS);
    expect(runTool).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS);
    expect(result.iterations).toBe(MAX_TOOL_ITERATIONS);
    expect(result.hitIterationCap).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("offers the model exactly the seven MCP tools", async () => {
    const callModel = vi.fn().mockResolvedValue(textTurn("Hi."));
    await runAssistant({
      workspaceId: SESSION_WORKSPACE,
      role: "OWNER",
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: FAKE_KEY,
      messages: [{ role: "user", text: "hi", toolCalls: [], toolResults: [] }],
      runTool: vi.fn(),
      callModel,
    });

    const tools = callModel.mock.calls[0][0].tools;
    expect(tools).toBe(MCP_TOOLS);
    expect(tools).toHaveLength(7);
  });

  it("does not offer a MEMBER the tools that write", async () => {
    const callModel = vi.fn().mockResolvedValue(textTurn("Hi."));
    await runAssistant({
      workspaceId: SESSION_WORKSPACE,
      role: "MEMBER",
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: FAKE_KEY,
      messages: [{ role: "user", text: "hi", toolCalls: [], toolResults: [] }],
      runTool: vi.fn(),
      callModel,
    });

    const names = callModel.mock.calls[0][0].tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(names).toEqual(mcpToolsForRole("MEMBER").map((tool) => tool.name));
    expect(names).not.toContain("create_campaign");
    expect(names).not.toContain("update_campaign");
  });

  it("passes the session role to the tool runner, not one the model invented", async () => {
    const runTool = vi.fn().mockResolvedValue({ campaigns: [] });
    const callModel = vi
      .fn()
      .mockResolvedValueOnce(toolTurn("list_campaigns", { role: "OWNER" }))
      .mockResolvedValueOnce(textTurn("Here."));

    await runAssistant({
      workspaceId: SESSION_WORKSPACE,
      role: "MEMBER",
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      apiKey: FAKE_KEY,
      messages: [{ role: "user", text: "list", toolCalls: [], toolResults: [] }],
      runTool,
      callModel,
    });

    expect(runTool.mock.calls[0][3]).toBe("MEMBER");
  });
});

describe("assistant rate limit", () => {
  it("lets a workspace through up to the per-minute cap and then holds it", () => {
    const perMinute = ASSISTANT_WINDOWS[0].max;
    for (let i = 0; i < perMinute; i += 1) {
      expect(checkAssistantRateLimit("ws_rl", 1_000).allowed).toBe(true);
    }
    const blocked = checkAssistantRateLimit("ws_rl", 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each workspace separately", () => {
    for (let i = 0; i < ASSISTANT_WINDOWS[0].max; i += 1) {
      checkAssistantRateLimit("ws_a", 1_000);
    }
    expect(checkAssistantRateLimit("ws_a", 1_000).allowed).toBe(false);
    expect(checkAssistantRateLimit("ws_b", 1_000).allowed).toBe(true);
  });

  it("reopens once the window has passed", () => {
    for (let i = 0; i < ASSISTANT_WINDOWS[0].max; i += 1) {
      checkAssistantRateLimit("ws_c", 1_000);
    }
    expect(checkAssistantRateLimit("ws_c", 1_000).allowed).toBe(false);
    expect(checkAssistantRateLimit("ws_c", 1_000 + 61_000).allowed).toBe(true);
  });
});

describe("POST /api/assistant", () => {
  it("requires a session", async () => {
    mockContext.mockResolvedValue(null);
    const response = await ask({ messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("unauthorized");
  });

  it("returns a structured refusal, not a 500, when no key is configured", async () => {
    mockGetCredential.mockResolvedValue(null);

    const response = await ask({ messages: [{ role: "user", content: "hi" }] });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_key");
    expect(body.error).toContain("Settings");
    expect(mockCallProvider).not.toHaveBeenCalled();
  });

  it("answers with the message and the tool trace", async () => {
    mockCallProvider
      .mockResolvedValueOnce(toolTurn("list_campaigns", {}))
      .mockResolvedValueOnce(textTurn("You have two live campaigns."));

    const response = await ask({
      messages: [{ role: "user", content: "what is live?" }],
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toBe("You have two live campaigns.");
    expect(body.toolCalls).toEqual([{ name: "list_campaigns", ok: true }]);
    expect(body.truncated).toBe(false);
  });

  it("scopes tool execution to the session workspace even when the model asks otherwise", async () => {
    mockCallProvider
      .mockResolvedValueOnce(
        toolTurn("list_campaigns", { workspaceId: OTHER_WORKSPACE })
      )
      .mockResolvedValueOnce(textTurn("Here they are."));

    await ask({ messages: [{ role: "user", content: "list them" }] });

    expect(mockRunMcpTool).toHaveBeenCalledTimes(1);
    const [, args, workspaceId] = mockRunMcpTool.mock.calls[0];
    expect(workspaceId).toBe(SESSION_WORKSPACE);
    expect(args).not.toHaveProperty("workspaceId");
  });

  it("never puts the workspace key in a response body", async () => {
    mockCallProvider
      .mockResolvedValueOnce(toolTurn("list_dm_logs", {}))
      .mockResolvedValueOnce(textTurn("Six failed yesterday."));

    const response = await ask({
      messages: [{ role: "user", content: "any failures?" }],
    });
    const body = await response.text();

    expect(body).not.toContain(FAKE_KEY);
    expect(body).not.toContain("apiKey");
    expect(body).not.toContain("encryptedKey");
  });

  it("passes the provider's own error through as a readable refusal", async () => {
    mockCallProvider.mockRejectedValue(
      new ProviderError("Your credit balance is too low", 400, false)
    );

    const response = await ask({ messages: [{ role: "user", content: "hi" }] });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("provider_error");
    expect(body.error).toBe("Your credit balance is too low");
  });

  it("sanitises an unexpected failure instead of leaking it", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockCallProvider.mockRejectedValue(
      new Error(`connect ECONNREFUSED with ${FAKE_KEY}`)
    );

    const response = await ask({ messages: [{ role: "user", content: "hi" }] });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(FAKE_KEY);
    expect(body).not.toContain("ECONNREFUSED");
    expect(JSON.parse(body).code).toBe("assistant_failed");
    consoleError.mockRestore();
  });

  it("rejects an empty, oversized or wrongly-ordered conversation", async () => {
    expect((await ask({ messages: [] })).status).toBe(400);

    const tooMany = Array.from({ length: MAX_INPUT_MESSAGES + 1 }, () => ({
      role: "user",
      content: "hi",
    }));
    expect((await ask({ messages: tooMany })).status).toBe(400);

    const endsAssistant = await ask({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(endsAssistant.status).toBe(400);
    expect(mockCallProvider).not.toHaveBeenCalled();
  });

  it("throttles one workspace without touching another", async () => {
    for (let i = 0; i < ASSISTANT_WINDOWS[0].max; i += 1) {
      await ask({ messages: [{ role: "user", content: "hi" }] });
    }

    const limited = await ask({ messages: [{ role: "user", content: "hi" }] });
    const body = await limited.json();

    expect(limited.status).toBe(429);
    expect(body.code).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);

    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: "workspace_other_tenant",
      workspace: { id: "workspace_other_tenant", name: "Theirs" },
      role: "OWNER",
    });
    const other = await ask({ messages: [{ role: "user", content: "hi" }] });
    expect(other.status).toBe(200);
  });
});
