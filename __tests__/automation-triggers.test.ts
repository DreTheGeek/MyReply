import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: {
      findUnique: vi.fn(),
    },
    instagramAccount: {
      findFirst: vi.fn(),
    },
    automation: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    trackedLink: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(async () => "workspace_123"),
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: "workspace_123",
    role: "OWNER",
  })),
  canManageWorkspace: () => true,
}));

import { NextRequest } from "next/server";

import { PATCH, POST } from "../app/api/automations/route";

// The fields every campaign needs, minus anything about what triggers it.
const baseCampaign = {
  name: "Story campaign",
  instagramAccountId: "instagram_account_123",
  keywords: ["LINK"],
  dmMessage: "here you go {link}",
};

function createCampaign(body: Record<string, unknown>) {
  return POST(
    new Request("https://myreply.test/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0]
  );
}

function updateCampaign(body: Record<string, unknown>) {
  return PATCH(
    new NextRequest("https://myreply.test/api/automations?id=automation_123", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_123" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "instagram_account_123",
  });
  mockPrisma.automation.create.mockResolvedValue({ id: "automation_123" });
  mockPrisma.automation.findFirst.mockResolvedValue({
    id: "automation_123",
    workspaceId: "workspace_123",
  });
  mockPrisma.automation.update.mockResolvedValue({ id: "automation_123" });
});

describe("POST /api/automations: triggers that need no post", () => {
  it("accepts a story-mention-only campaign with no post target", async () => {
    const response = await createCampaign({
      ...baseCampaign,
      storyMentionEnabled: true,
    });

    expect(response.status).toBe(201);
    const [[created]] = mockPrisma.automation.create.mock.calls;
    expect(created.data.postId).toBeFalsy();
    expect(created.data.storyMentionEnabled).toBe(true);
  });

  it("accepts a referral-only campaign with no post target", async () => {
    const response = await createCampaign({
      ...baseCampaign,
      referralRef: "spring-flyer",
    });

    expect(response.status).toBe(201);
    const [[created]] = mockPrisma.automation.create.mock.calls;
    expect(created.data.postId).toBeFalsy();
    expect(created.data.referralRef).toBe("spring-flyer");
  });

  it("accepts a default-reply-only campaign with no post target", async () => {
    const response = await createCampaign({
      ...baseCampaign,
      defaultReplyEnabled: true,
    });

    expect(response.status).toBe(201);
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ defaultReplyEnabled: true }),
      })
    );
  });

  it("rejects a campaign with neither a post nor any trigger", async () => {
    const response = await createCampaign(baseCampaign);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.details.fieldErrors.postId).toBeTruthy();
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("still rejects a whitespace-only referral ref as a trigger", async () => {
    const response = await createCampaign({
      ...baseCampaign,
      referralRef: "   ",
    });

    expect(response.status).toBe(400);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("keeps accepting a plain post-triggered campaign", async () => {
    const response = await createCampaign({
      ...baseCampaign,
      postId: "post_123",
    });

    expect(response.status).toBe(201);
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ postId: "post_123" }),
      })
    );
  });

  it("stores every trigger flag and blanks an unused ref", async () => {
    const response = await createCampaign({
      ...baseCampaign,
      postId: "post_123",
      storyReplyEnabled: true,
      storyMentionEnabled: true,
      liveCommentEnabled: true,
      defaultReplyEnabled: true,
      referralRef: "",
    });

    expect(response.status).toBe(201);
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storyReplyEnabled: true,
          storyMentionEnabled: true,
          liveCommentEnabled: true,
          defaultReplyEnabled: true,
          referralRef: null,
        }),
      })
    );
  });

  it("defaults every new trigger to off when they are not sent", async () => {
    await createCampaign({ ...baseCampaign, postId: "post_123" });

    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storyReplyEnabled: false,
          storyMentionEnabled: false,
          liveCommentEnabled: false,
          defaultReplyEnabled: false,
          referralRef: null,
        }),
      })
    );
  });
});

describe("PATCH /api/automations: editing the new triggers", () => {
  it("updates the trigger flags and trims the referral ref", async () => {
    const response = await updateCampaign({
      storyReplyEnabled: true,
      liveCommentEnabled: true,
      referralRef: "  qr-poster  ",
    });

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_123" },
      data: expect.objectContaining({
        storyReplyEnabled: true,
        liveCommentEnabled: true,
        referralRef: "qr-poster",
      }),
    });
  });

  it("clears the referral ref when it is emptied", async () => {
    await updateCampaign({ referralRef: "" });

    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_123" },
      data: expect.objectContaining({ referralRef: null }),
    });
  });

  it("leaves the referral ref alone when it is not sent", async () => {
    await updateCampaign({ storyMentionEnabled: true });

    const [call] = mockPrisma.automation.update.mock.calls;
    expect(call[0].data).not.toHaveProperty("referralRef");
    expect(call[0].data).toMatchObject({ storyMentionEnabled: true });
  });
});
