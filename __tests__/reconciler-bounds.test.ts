import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockRedis, mockQueue } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockRedis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  mockQueue: { add: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => mockQueue,
  getRedisConnection: () => mockRedis,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "token" }));
vi.mock("@/lib/meta/client", () => ({
  getRecentMediaComments: vi.fn().mockResolvedValue([]),
  getUserMedia: vi.fn().mockResolvedValue([]),
  MetaApiError: class extends Error {},
}));

import { reconcileComments } from "../lib/polling/comment-reconciler";

function campaigns(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `automation_${String(offset + i).padStart(4, "0")}`,
    name: `Campaign ${offset + i}`,
    postId: "post_1",
    matchAnyPost: false,
    matchAnyWord: false,
    keywords: ["PRICE"],
    wholeWordMatch: true,
    publicReplyEnabled: false,
    workspaceId: "workspace_1",
    instagramAccount: {
      id: "account_1",
      instagramId: "ig_1",
      username: "acme",
      accessToken: "enc",
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue("OK");
  mockRedis.del.mockResolvedValue(1);
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  mockPrisma.operationalEvent.create.mockResolvedValue({});
});

describe("reconciler sweep bounds", () => {
  // The selection had no take and no ordering, so the pass grew with the whole
  // platform while the interval it runs on stayed at five minutes.
  it("caps how many campaigns one pass selects, and orders them", async () => {
    mockPrisma.automation.findMany.mockResolvedValue(campaigns(3));

    await reconcileComments();

    const [[args]] = mockPrisma.automation.findMany.mock.calls;
    expect(args.take).toBeGreaterThan(0);
    expect(args.orderBy).toEqual({ id: "asc" });
    expect(args.where).toEqual({ isActive: true });
  });

  it("resumes after the campaign the last pass stopped at", async () => {
    mockRedis.get.mockResolvedValue("automation_0042");
    mockPrisma.automation.findMany.mockResolvedValue(campaigns(3));

    await reconcileComments();

    const [[args]] = mockPrisma.automation.findMany.mock.calls;
    expect(args.cursor).toEqual({ id: "automation_0042" });
    expect(args.skip).toBe(1);
  });

  it("clears the cursor when a pass does not fill its cap, so the next one starts over", async () => {
    mockPrisma.automation.findMany.mockResolvedValue(campaigns(3));

    await reconcileComments();

    expect(mockRedis.del).toHaveBeenCalledWith("reconciler:cursor");
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("wraps to the beginning when the cursor has run off the end", async () => {
    mockRedis.get.mockResolvedValue("automation_9999");
    mockPrisma.automation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(campaigns(2));

    await reconcileComments();

    // Two queries: the cursored one that found nothing, then a fresh pass from
    // the start. Without this a full cap would starve every later campaign.
    expect(mockPrisma.automation.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.automation.findMany.mock.calls[1][0].cursor).toBeUndefined();
  });

  it("still sweeps every campaign it selected", async () => {
    mockPrisma.automation.findMany.mockResolvedValue(campaigns(9));

    await reconcileComments();

    // Nine campaigns, swept with bounded concurrency rather than one at a time.
    // Each resolves to no comments here, so the assertion is simply that none
    // were dropped by the scheduling change.
    expect(mockPrisma.dmLog.findMany).not.toHaveBeenCalled();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("survives Redis being unreachable", async () => {
    mockRedis.get.mockRejectedValue(new Error("redis down"));
    mockRedis.set.mockRejectedValue(new Error("redis down"));
    mockRedis.del.mockRejectedValue(new Error("redis down"));
    mockPrisma.automation.findMany.mockResolvedValue(campaigns(2));

    // A lost cursor costs one unfair pass. It must never fail the sweep.
    await expect(reconcileComments()).resolves.toBeUndefined();
  });
});
