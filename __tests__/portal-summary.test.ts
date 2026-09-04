import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockGetCurrentDMCount } = vi.hoisted(() => ({
  mockPrisma: {
    dmLog: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    linkClick: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    automation: { findMany: vi.fn(), count: vi.fn() },
    instagramAccount: { findMany: vi.fn() },
    operationalEvent: { findMany: vi.fn(), count: vi.fn() },
    workspace: { findUnique: vi.fn() },
  },
  mockGetCurrentDMCount: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/utils/rate-limiter", () => ({
  getCurrentDMCount: mockGetCurrentDMCount,
  RATE_LIMIT_MAX: 750,
}));

import { buildPortalSummary } from "../lib/portal/summary";

const WS = "ws_1";
const DAY = 86_400_000;

function run(instagramAccountId: string | null = null) {
  return buildPortalSummary({
    workspaceId: WS,
    userName: "LaSean",
    instagramAccountId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.dmLog.groupBy.mockResolvedValue([]);
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  mockPrisma.dmLog.count.mockResolvedValue(0);
  mockPrisma.linkClick.count.mockResolvedValue(0);
  mockPrisma.linkClick.groupBy.mockResolvedValue([]);
  mockPrisma.linkClick.findMany.mockResolvedValue([]);
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.automation.count.mockResolvedValue(0);
  mockPrisma.instagramAccount.findMany.mockResolvedValue([]);
  mockPrisma.operationalEvent.findMany.mockResolvedValue([]);
  mockPrisma.operationalEvent.count.mockResolvedValue(0);
  mockPrisma.workspace.findUnique.mockResolvedValue({
    dmsSentThisPeriod: 12,
    usagePeriodStart: new Date("2026-09-01T00:00:00Z"),
  });
  mockGetCurrentDMCount.mockResolvedValue(0);
});

describe("workspace scoping", () => {
  it("scopes every DM query to the caller's workspace", async () => {
    await run();
    for (const call of mockPrisma.dmLog.groupBy.mock.calls) {
      expect(call[0].where.workspaceId).toBe(WS);
    }
    for (const call of mockPrisma.dmLog.findMany.mock.calls) {
      expect(call[0].where.workspaceId).toBe(WS);
    }
  });

  it("treats no account as every account rather than narrowing to one", async () => {
    await run(null);
    for (const call of mockPrisma.dmLog.groupBy.mock.calls) {
      expect(call[0].where.instagramAccountId).toBeUndefined();
    }
    // The account panel must still list every account in the workspace.
    const accountCall = mockPrisma.instagramAccount.findMany.mock.calls[0][0];
    expect(accountCall.where.id).toBeUndefined();
    expect(accountCall.where.workspaceId).toBe(WS);
  });

  it("applies a named account to both the logs and the account panel", async () => {
    await run("acct_1");
    expect(
      mockPrisma.dmLog.groupBy.mock.calls[0][0].where.instagramAccountId
    ).toBe("acct_1");
    expect(
      mockPrisma.instagramAccount.findMany.mock.calls[0][0].where.id
    ).toBe("acct_1");
  });
});

describe("click rate", () => {
  it("reports zero rather than dividing by zero", async () => {
    const summary = await run();
    expect(summary.kpis.clickRate.value).toBe("0%");
    expect(summary.panels.performance.clickRate).toBe(0);
  });

  it("computes against sends, not against every log row", async () => {
    mockPrisma.dmLog.groupBy.mockResolvedValue([
      { status: "SENT", _count: { _all: 200 } },
      { status: "FAILED", _count: { _all: 300 } },
    ]);
    // Fifty distinct ipHash groups is fifty people, not fifty taps.
    mockPrisma.linkClick.groupBy.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({ ipHash: 'h' + i, _count: { _all: 3 } }))
    );

    const summary = await run();
    expect(summary.kpis.clickRate.value).toBe("25%");
  });
});

describe("the overnight sentence", () => {
  it("says so plainly when nothing happened", async () => {
    const summary = await run();
    expect(summary.greeting.overnight).toBe(
      "Quiet in the last 12 hours, and nothing is waiting on you."
    );
    expect(summary.greeting.needsYouCount).toBe(0);
  });

  it("counts only sends inside the last 12 hours, not the whole series", async () => {
    const now = Date.now();
    mockPrisma.dmLog.findMany.mockImplementation((args: {
      where: { status?: unknown };
    }) => {
      if (args.where.status === "SENT") {
        return Promise.resolve([
          { createdAt: new Date(now - 60_000) },
          { createdAt: new Date(now - 2 * 3_600_000) },
          // Older than 12 hours, so it must not be counted.
          { createdAt: new Date(now - 5 * DAY) },
        ]);
      }
      return Promise.resolve([]);
    });

    const summary = await run();
    expect(summary.greeting.overnight).toContain("2 DMs went out");
  });
});

describe("derived tasks", () => {
  it("raises a task for a token expiring inside a week", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      {
        id: "acct_1",
        username: "lasean",
        instagramId: "ig_1",
        tokenExpiresAt: new Date(Date.now() + 2 * DAY),
        webhookSubscribed: true,
      },
    ]);

    const summary = await run();
    const task = summary.tasks.find((item) => item.id === "token-acct_1");
    expect(task).toBeDefined();
    expect(task?.severity).toBe("error");
    expect(summary.greeting.needsYouCount).toBe(1);
  });

  it("does not raise a token task for a healthy token", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      {
        id: "acct_1",
        username: "lasean",
        instagramId: "ig_1",
        tokenExpiresAt: new Date(Date.now() + 45 * DAY),
        webhookSubscribed: true,
      },
    ]);

    const summary = await run();
    expect(summary.tasks).toHaveLength(0);
    expect(summary.kpis.systemHealth.value).toBe("Healthy");
  });

  it("flags a live campaign that has no keywords and can never fire", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "camp_1",
        name: "Lead magnet",
        keywords: [],
        matchAnyPost: true,
        instagramAccount: { username: "lasean" },
      },
    ]);

    const summary = await run();
    expect(summary.tasks.some((task) => task.id === "campaign-camp_1")).toBe(
      true
    );
  });
});

describe("capacity", () => {
  it("reports the busiest account, not an average", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "a", username: "a", instagramId: "1", tokenExpiresAt: null, webhookSubscribed: true },
      { id: "b", username: "b", instagramId: "2", tokenExpiresAt: null, webhookSubscribed: true },
    ]);
    mockGetCurrentDMCount.mockImplementation((id: string) =>
      Promise.resolve(id === "a" ? 375 : 0)
    );

    const summary = await run();
    expect(summary.kpis.capacityUsed.value).toBe("50%");
  });

  it("falls back to counting sends when the live counter is unavailable", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "a", username: "a", instagramId: "1", tokenExpiresAt: null, webhookSubscribed: true },
    ]);
    mockGetCurrentDMCount.mockRejectedValue(new Error("redis down"));
    mockPrisma.dmLog.groupBy.mockImplementation((args: {
      by: string[];
    }) =>
      args.by[0] === "instagramAccountId"
        ? Promise.resolve([{ instagramAccountId: "a", _count: { _all: 75 } }])
        : Promise.resolve([])
    );

    const summary = await run();
    expect(summary.kpis.capacityUsed.value).toBe("10%");
    expect(summary.kpis.capacityUsed.comparison).toContain("live counter");
  });
});

describe("usage", () => {
  it("reports the billing meter rather than recounting the logs", async () => {
    const summary = await run();
    expect(summary.usage.dmsThisPeriod).toBe(12);
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalled();
  });
});
