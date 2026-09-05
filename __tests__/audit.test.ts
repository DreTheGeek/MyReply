import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { operationalEvent: { create: vi.fn() } },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { recordAuditEvent } from "../lib/audit";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.operationalEvent.create.mockResolvedValue({});
});

describe("recordAuditEvent", () => {
  it("writes who did what to which thing", async () => {
    await recordAuditEvent({
      workspaceId: "workspace_1",
      action: "campaign.deleted",
      actorUserId: "user_1",
      targetId: "automation_9",
      detail: { name: "Price replies" },
    });

    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_1",
        source: "SYSTEM",
        level: "INFO",
        message: "campaign.deleted",
        payload: {
          actorUserId: "user_1",
          targetId: "automation_9",
          name: "Price replies",
        },
        resolvedAt: expect.any(Date),
      },
    });
  });

  // An API key has no user behind it, and the empty string that
  // getCurrentWorkspaceContext returns for one is not a valid user id.
  it("normalises an empty actor to null rather than storing a blank id", async () => {
    await recordAuditEvent({
      workspaceId: "workspace_1",
      action: "tag.deleted",
      actorUserId: "",
      targetId: "tag_1",
    });

    const [[call]] = mockPrisma.operationalEvent.create.mock.calls;
    expect(call.data.payload.actorUserId).toBeNull();
  });

  it("marks the entry resolved, so routine deletions do not look like incidents", async () => {
    await recordAuditEvent({
      workspaceId: "workspace_1",
      action: "member.removed",
    });

    const [[call]] = mockPrisma.operationalEvent.create.mock.calls;
    // The diagnostics page surfaces unresolved events. Filling that feed with
    // every delete would bury the failures it exists to show.
    expect(call.data.resolvedAt).toBeInstanceOf(Date);
    expect(call.data.level).toBe("INFO");
  });

  // The destructive work has already committed by the time this runs. Throwing
  // here would report a failure for something that did happen, and the caller
  // would retry it.
  it("never throws when the write fails", async () => {
    mockPrisma.operationalEvent.create.mockRejectedValue(new Error("db down"));

    await expect(
      recordAuditEvent({ workspaceId: "workspace_1", action: "tag.deleted" })
    ).resolves.toBeUndefined();
  });
});
