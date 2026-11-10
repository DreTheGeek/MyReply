/**
 * Usage metering: every send through a stored account is counted once, by
 * workspace, day, platform and kind, and counting never changes what the
 * platform answered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    usageDaily: { upsert: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { Prisma } from "../app/generated/prisma/client";
import type { ChannelAdapter } from "../lib/channels/adapter";
import { instrumentAdapter, registerChannelObserver } from "../lib/channels/instrument";
import { recordUsage, usageDay, usageReport } from "../lib/usage/meter";
import { parseUsageRange } from "../lib/usage/range";

function fakeAdapter(send: ChannelAdapter["messaging"]["send"]): ChannelAdapter {
  return {
    platform: "INSTAGRAM",
    messaging: {
      send,
      publicReply: vi.fn(async () => ({ id: "reply_1" })),
      followStatus: vi.fn(),
      username: vi.fn(),
    },
  } as unknown as ChannelAdapter;
}

const context = { platform: "INSTAGRAM" as const, accountExternalId: "ig_1", accessToken: "t" };
const scope = { workspaceId: "ws_1", accountId: "acct_1", source: "automation" as const };
const textTo = { to: { kind: "user" as const, userId: "u1" }, content: { kind: "text" as const, text: "hi" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.usageDaily.upsert.mockResolvedValue({});
  mockPrisma.usageDaily.update.mockResolvedValue({});
});

describe("recording usage", () => {
  it("adds to the day's row for the workspace, platform and kind, in UTC", async () => {
    await recordUsage({
      workspaceId: "ws_1",
      platform: "FACEBOOK",
      kind: "AI_REPLY",
      costMicros: 560,
      at: new Date("2026-11-10T23:30:00-05:00"),
    });
    const call = mockPrisma.usageDaily.upsert.mock.calls[0][0];
    expect(call.where.workspaceId_day_platform_kind).toEqual({
      workspaceId: "ws_1",
      day: new Date("2026-11-11T00:00:00Z"),
      platform: "FACEBOOK",
      kind: "AI_REPLY",
    });
    expect(call.create).toMatchObject({ count: 1, costMicros: BigInt(560) });
    expect(call.update).toEqual({
      count: { increment: 1 },
      costMicros: { increment: BigInt(560) },
      platformFeeMicros: { increment: BigInt(0) },
    });
  });

  it("adds to the row another writer created first", async () => {
    mockPrisma.usageDaily.upsert.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" })
    );
    await recordUsage({ workspaceId: "ws_1", platform: "INSTAGRAM", kind: "MESSAGE_SENT" });
    expect(mockPrisma.usageDaily.update).toHaveBeenCalledTimes(1);
  });

  it("never throws, and says what it could not record", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.usageDaily.upsert.mockRejectedValueOnce(new Error("down"));
    await expect(
      recordUsage({ workspaceId: "ws_1", platform: "INSTAGRAM", kind: "MESSAGE_SENT" })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      "[usage] Could not record usage:",
      expect.objectContaining({ workspaceId: "ws_1", kind: "MESSAGE_SENT", count: 1 })
    );
    spy.mockRestore();
  });

  it("files a moment under its UTC day", () => {
    expect(usageDay(new Date("2026-01-01T00:00:00Z")).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(usageDay(new Date("2026-01-01T23:59:59Z")).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("every send through a stored account", () => {
  it("is counted once when the platform accepts it", async () => {
    const adapter = instrumentAdapter(fakeAdapter(vi.fn(async () => ({ messageId: "m1" }))), scope);
    await expect(adapter.messaging.send(context, textTo)).resolves.toEqual({ messageId: "m1" });
    expect(mockPrisma.usageDaily.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.usageDaily.upsert.mock.calls[0][0].create).toMatchObject({
      workspaceId: "ws_1",
      platform: "INSTAGRAM",
      kind: "MESSAGE_SENT",
    });
  });

  it("is not counted when refused, and the refusal comes through unchanged", async () => {
    const refusal = new Error("window closed");
    const adapter = instrumentAdapter(
      fakeAdapter(vi.fn(async () => {
        throw refusal;
      })),
      scope
    );
    await expect(adapter.messaging.send(context, textTo)).rejects.toBe(refusal);
    expect(mockPrisma.usageDaily.upsert).not.toHaveBeenCalled();
  });

  it("counts a public reply as its own kind", async () => {
    const adapter = instrumentAdapter(fakeAdapter(vi.fn()), scope);
    await adapter.messaging.publicReply(context, { commentId: "c1", text: "Sent you a DM" });
    expect(mockPrisma.usageDaily.upsert.mock.calls[0][0].create.kind).toBe("PUBLIC_REPLY");
  });

  it("still returns the receipt when an observer breaks", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerChannelObserver({
      sent: async () => {
        throw new Error("observer down");
      },
      failed: async () => undefined,
      publicReplied: async () => undefined,
    });
    const adapter = instrumentAdapter(fakeAdapter(vi.fn(async () => ({ messageId: "m2" }))), scope);
    await expect(adapter.messaging.send(context, textTo)).resolves.toEqual({ messageId: "m2" });
    spy.mockRestore();
  });

  it("leaves the shared adapter itself untouched", () => {
    const original = fakeAdapter(vi.fn());
    const originalSend = original.messaging.send;
    instrumentAdapter(original, scope);
    expect(original.messaging.send).toBe(originalSend);
  });
});

describe("the usage report", () => {
  it("totals by kind, platform and day, with money as whole millionths", async () => {
    mockPrisma.usageDaily.findMany.mockResolvedValue([
      { day: new Date("2026-11-01"), platform: "INSTAGRAM", kind: "MESSAGE_SENT", count: 10, costMicros: BigInt(0), platformFeeMicros: BigInt(0) },
      { day: new Date("2026-11-01"), platform: "INSTAGRAM", kind: "AI_REPLY", count: 2, costMicros: BigInt(1120), platformFeeMicros: BigInt(0) },
      { day: new Date("2026-11-02"), platform: "FACEBOOK", kind: "MESSAGE_SENT", count: 3, costMicros: BigInt(0), platformFeeMicros: BigInt(0) },
      { day: new Date("2026-11-02"), platform: "FACEBOOK", kind: "PUBLIC_REPLY", count: 1, costMicros: BigInt(0), platformFeeMicros: BigInt(0) },
    ]);
    const report = await usageReport("ws_1", new Date("2026-11-01"), new Date("2026-11-30"));
    expect(mockPrisma.usageDaily.findMany.mock.calls[0][0].where.workspaceId).toBe("ws_1");
    expect(report.totals).toEqual({
      messagesSent: 13,
      publicReplies: 1,
      aiReplies: 2,
      aiCostMicros: 1120,
      platformFeeMicros: 0,
    });
    expect(report.byPlatform.map((row) => [row.platform, row.messagesSent])).toEqual([
      ["INSTAGRAM", 10],
      ["FACEBOOK", 3],
    ]);
    expect(report.byDay.map((row) => row.day)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(JSON.stringify(report)).toBeTruthy();
  });
});

describe("usage ranges", () => {
  const now = new Date("2026-11-11T15:00:00Z");
  it("defaults to the month so far", () => {
    const range = parseUsageRange(new URLSearchParams(), now);
    expect(range.ok && range.from.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("refuses a malformed, backwards or over-long range", () => {
    expect(parseUsageRange(new URLSearchParams({ from: "11/01/2026" }), now).ok).toBe(false);
    expect(parseUsageRange(new URLSearchParams({ from: "2026-11-05", to: "2026-11-01" }), now).ok).toBe(false);
    expect(parseUsageRange(new URLSearchParams({ from: "2024-01-01", to: "2026-01-01" }), now).ok).toBe(false);
    expect(parseUsageRange(new URLSearchParams({ from: "2026-02-31" }), now).ok).toBe(false);
  });
});
