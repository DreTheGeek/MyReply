import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findMany: vi.fn(), findFirst: vi.fn() },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    trackedLink: { create: vi.fn() },
    dmLog: { groupBy: vi.fn(), findMany: vi.fn() },
    linkClick: { count: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/tracking/server", () => ({
  generateTrackedLinkSlug: () => "slug123",
}));
vi.mock("@/lib/reports/share", () => ({
  generateReportShareSlug: () => "report123",
  buildReportUrl: (s: string) => `https://x/reports/${s}`,
  isReportBranded: () => false,
}));
vi.mock("@/lib/tracking/message", () => ({
  buildTrackedUrl: (s: string) => `https://x/r/${s}`,
}));

import { MCP_TOOLS, mcpToolsForRole, runMcpTool } from "../lib/mcp/tools";

const WS = "ws_1";
const ADMIN = "ADMIN" as const;
const MEMBER = "MEMBER" as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acct_1" });
  mockPrisma.automation.create.mockResolvedValue({
    id: "camp_1",
    name: "Guide",
    keywords: ["guide"],
    isActive: true,
  });
  mockPrisma.automation.update.mockResolvedValue({
    id: "camp_1",
    name: "Guide",
    keywords: ["guide"],
    isActive: false,
  });
  mockPrisma.trackedLink.create.mockResolvedValue({});
});

describe("tool definitions", () => {
  it("every tool has a name, a description and a schema", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(30);
      expect(tool.inputSchema).toHaveProperty("type", "object");
    }
  });

  it("no tool accepts a workspace id, which would let a model pick a tenant", () => {
    for (const tool of MCP_TOOLS) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> })
        .properties;
      expect(Object.keys(props ?? {})).not.toContain("workspaceId");
    }
  });
});

describe("workspace isolation", () => {
  it("create_campaign refuses an account from another workspace", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    await expect(
      runMcpTool(
        "create_campaign",
        {
          name: "x",
          instagramAccountId: "acct_other",
          keywords: ["a"],
          dmMessage: "hi",
          matchAnyPost: true,
        },
        WS,
        ADMIN
      )
    ).rejects.toThrow(/Unknown Instagram account/);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("update_campaign refuses a campaign from another workspace", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    await expect(
      runMcpTool("update_campaign", { id: "camp_other", isActive: false }, WS, ADMIN)
    ).rejects.toThrow(/Unknown campaign/);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("scopes every list query to the caller's workspace", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    await runMcpTool("list_campaigns", {}, WS, ADMIN);
    expect(
      mockPrisma.automation.findMany.mock.calls[0][0].where.workspaceId
    ).toBe(WS);
  });
});

describe("create_campaign", () => {
  it("requires a post target or matchAnyPost", async () => {
    await expect(
      runMcpTool(
        "create_campaign",
        { name: "x", instagramAccountId: "acct_1", keywords: ["a"], dmMessage: "hi" },
        WS,
        ADMIN
      )
    ).rejects.toThrow(/matchAnyPost/);
  });

  it("requires at least one keyword", async () => {
    await expect(
      runMcpTool(
        "create_campaign",
        {
          name: "x",
          instagramAccountId: "acct_1",
          keywords: [],
          dmMessage: "hi",
          matchAnyPost: true,
        },
        WS,
        ADMIN
      )
    ).rejects.toThrow(/keyword/);
  });

  it("requires a message", async () => {
    await expect(
      runMcpTool(
        "create_campaign",
        {
          name: "x",
          instagramAccountId: "acct_1",
          keywords: ["a"],
          dmMessage: "   ",
          matchAnyPost: true,
        },
        WS,
        ADMIN
      )
    ).rejects.toThrow(/dmMessage/);
  });

  it("creates a tracked link when a destination is given", async () => {
    const out = await runMcpTool(
      "create_campaign",
      {
        name: "Guide",
        instagramAccountId: "acct_1",
        keywords: ["guide"],
        dmMessage: "Here you go {username}",
        matchAnyPost: true,
        linkUrl: "https://example.com/guide",
      },
      WS,
      ADMIN
    );
    expect(mockPrisma.trackedLink.create).toHaveBeenCalled();
    expect(out.trackedUrl).toBe("https://x/r/slug123");
  });

  it("does not create a tracked link when no destination is given", async () => {
    const out = await runMcpTool(
      "create_campaign",
      {
        name: "Guide",
        instagramAccountId: "acct_1",
        keywords: ["guide"],
        dmMessage: "hi",
        matchAnyPost: true,
      },
      WS,
      ADMIN
    );
    expect(mockPrisma.trackedLink.create).not.toHaveBeenCalled();
    expect(out.trackedUrl).toBeNull();
  });
});

describe("update_campaign", () => {
  it("refuses an update that changes nothing", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "camp_1" });
    await expect(
      runMcpTool("update_campaign", { id: "camp_1" }, WS, ADMIN)
    ).rejects.toThrow(/Nothing to update/);
  });

  it("can pause a campaign", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "camp_1" });
    await runMcpTool("update_campaign", { id: "camp_1", isActive: false }, WS, ADMIN);
    expect(mockPrisma.automation.update.mock.calls[0][0].data).toEqual({
      isActive: false,
    });
  });
});

describe("get_campaign_performance", () => {
  it("computes a click rate from sends, not from every log row", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "c", name: "Guide" });
    mockPrisma.dmLog.groupBy.mockResolvedValue([
      { status: "SENT", _count: { _all: 200 } },
      { status: "FAILED", _count: { _all: 50 } },
    ]);
    mockPrisma.linkClick.count.mockResolvedValue(50);

    const out = await runMcpTool("get_campaign_performance", { id: "c" }, WS, ADMIN);
    expect(out.sent).toBe(200);
    expect(out.clickRate).toBe(25);
  });

  it("reports a zero click rate rather than dividing by zero", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "c", name: "Guide" });
    mockPrisma.dmLog.groupBy.mockResolvedValue([]);
    mockPrisma.linkClick.count.mockResolvedValue(0);

    const out = await runMcpTool("get_campaign_performance", { id: "c" }, WS, ADMIN);
    expect(out.clickRate).toBe(0);
  });
});

describe("the key's role", () => {
  it("refuses a write tool to a read-only key", async () => {
    await expect(
      runMcpTool(
        "create_campaign",
        {
          name: "x",
          instagramAccountId: "acct_1",
          keywords: ["a"],
          dmMessage: "hi",
          matchAnyPost: true,
        },
        WS,
        MEMBER
      )
    ).rejects.toThrow(/read only/i);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("refuses an update to a read-only key", async () => {
    await expect(
      runMcpTool("update_campaign", { id: "camp_1", isActive: false }, WS, MEMBER)
    ).rejects.toThrow(/read only/i);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("still allows a read-only key to read", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    await expect(
      runMcpTool("list_campaigns", {}, WS, MEMBER)
    ).resolves.toBeDefined();
  });

  it("does not advertise write tools to a read-only key", () => {
    const names = mcpToolsForRole(MEMBER).map((tool) => tool.name);
    expect(names).not.toContain("create_campaign");
    expect(names).not.toContain("update_campaign");
    expect(names).toContain("list_campaigns");
    expect(mcpToolsForRole(ADMIN)).toHaveLength(MCP_TOOLS.length);
  });
});

describe("unknown tools", () => {
  it("throws rather than silently doing nothing", async () => {
    await expect(runMcpTool("drop_everything", {}, WS, ADMIN)).rejects.toThrow(
      /Unknown tool/
    );
  });
});
