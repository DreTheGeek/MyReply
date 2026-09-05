import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext, mockCanManage } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    automation: { create: vi.fn() },
  },
  mockContext: vi.fn(),
  mockCanManage: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

const ROLE_ORDER: Record<string, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string): boolean => mockCanManage(role),
  hasWorkspaceRole: (role: string, minimumRole: string): boolean =>
    ROLE_ORDER[role] >= ROLE_ORDER[minimumRole],
}));

// The campaign create route reads the workspace id from lib/auth for its GET.
// Stubbing the module keeps NextAuth out of a node test without changing the
// path under test: the POST this exercises goes through workspace-access.
vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(async () => OWN_WORKSPACE),
  getRequestApiKeyContext: vi.fn(async () => null),
  getCurrentUserId: vi.fn(async () => "user_1"),
}));

import { NextRequest } from "next/server";

import { POST } from "../app/api/templates/[slug]/install/route";
import { TEMPLATE_CATALOGUE, getTemplate } from "../lib/templates/catalogue";

const OWN_WORKSPACE = "workspace_ours";
const OTHER_WORKSPACE = "workspace_theirs";

interface StoredAccount {
  id: string;
  workspaceId: string;
  connectedAt: Date;
}

const ACCOUNTS: StoredAccount[] = [
  { id: "ig_old", workspaceId: OWN_WORKSPACE, connectedAt: new Date(2024, 0, 1) },
  { id: "ig_new", workspaceId: OWN_WORKSPACE, connectedAt: new Date(2025, 0, 1) },
  { id: "ig_theirs", workspaceId: OTHER_WORKSPACE, connectedAt: new Date() },
];

type CreateArgs = { data: Record<string, unknown> };

let created: Record<string, unknown>[] = [];

function install(
  slug: string,
  body?: Record<string, unknown>
): Promise<Response> {
  return POST(
    new NextRequest(`https://myreply.test/api/templates/${slug}/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ slug }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  created = [];

  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: OWN_WORKSPACE,
    workspace: { id: OWN_WORKSPACE },
    role: "OWNER",
  });
  mockCanManage.mockImplementation((role: string) => role !== "MEMBER");

  mockPrisma.workspace.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      where.id === OWN_WORKSPACE ? { id: OWN_WORKSPACE } : null
  );

  mockPrisma.instagramAccount.findFirst.mockImplementation(
    async ({
      where,
      orderBy,
    }: {
      where: { id?: string; workspaceId: string };
      orderBy?: { connectedAt: "asc" | "desc" };
    }) => {
      const rows = ACCOUNTS.filter(
        (account) =>
          account.workspaceId === where.workspaceId &&
          (where.id === undefined || account.id === where.id)
      ).sort((a, b) =>
        orderBy?.connectedAt === "desc"
          ? b.connectedAt.getTime() - a.connectedAt.getTime()
          : a.connectedAt.getTime() - b.connectedAt.getTime()
      );
      return rows[0] ?? null;
    }
  );

  mockPrisma.automation.create.mockImplementation(async ({ data }: CreateArgs) => {
    created.push(data);
    const links = (
      data.trackedLinks as { create?: Record<string, unknown>[] } | undefined
    )?.create;
    return {
      id: `automation_${created.length}`,
      ...data,
      trackedLinks: links ?? [],
    };
  });
});

describe("POST /api/templates/[slug]/install", () => {
  it("builds a campaign the real create route accepts, for every template", async () => {
    for (const template of TEMPLATE_CATALOGUE) {
      created = [];
      const response = await install(template.slug);
      const payload = await response.json();

      expect({ slug: template.slug, status: response.status }).toEqual({
        slug: template.slug,
        status: 201,
      });
      expect(payload.success).toBe(true);
      expect(payload.data.templateSlug).toBe(template.slug);
      expect(payload.data.redirectTo).toBe(
        `/campaigns/${payload.data.automation.id}`
      );

      const row = created[0];
      expect(row.workspaceId).toBe(OWN_WORKSPACE);
      expect(row.dmMessage).toBe(template.preset.dmMessage);
      expect(row.goal).toBe(template.goal);
      expect(row.name).toBe(template.name);
      // Every install gets a report slug, exactly as a hand built campaign does.
      expect(row.reportShareSlug).toBeTruthy();
    }
  });

  it("installs against any post with an empty body and one account choice", async () => {
    const response = await install("lead-magnet");

    expect(response.status).toBe(201);
    // The newest connected account, without being asked which one.
    expect(created[0].instagramAccountId).toBe("ig_new");
    expect(created[0].matchAnyPost).toBe(true);
    expect(created[0].postId).toBeNull();
  });

  it("installs against a chosen post and account", async () => {
    const response = await install("lead-magnet", {
      instagramAccountId: "ig_old",
      postId: "17900000000000000",
      postUrl: "https://instagram.com/p/abc/",
    });

    expect(response.status).toBe(201);
    expect(created[0].instagramAccountId).toBe("ig_old");
    expect(created[0].matchAnyPost).toBe(false);
    expect(created[0].postId).toBe("17900000000000000");
  });

  it("refuses an Instagram account belonging to another workspace", async () => {
    const response = await install("lead-magnet", {
      instagramAccountId: "ig_theirs",
    });

    // A 404 rather than a 403: a 403 would confirm the id exists elsewhere.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Instagram account not found",
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("refuses a member", async () => {
    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: OWN_WORKSPACE,
      workspace: { id: OWN_WORKSPACE },
      role: "MEMBER",
    });

    const response = await install("lead-magnet");

    expect(response.status).toBe(403);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("refuses a caller with no workspace", async () => {
    mockContext.mockResolvedValue(null);

    const response = await install("lead-magnet");

    expect(response.status).toBe(401);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("refuses a slug that is not in the catalogue, before touching the database", async () => {
    const response = await install("../automations");

    expect(response.status).toBe(404);
    expect(mockContext).not.toHaveBeenCalled();
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an install", async () => {
    const response = await install("lead-magnet", {
      destinationUrl: "not a url",
    });

    expect(response.status).toBe(400);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("explains an empty workspace rather than failing silently", async () => {
    mockContext.mockResolvedValue({
      userId: "user_3",
      workspaceId: "workspace_empty",
      workspace: { id: "workspace_empty" },
      role: "OWNER",
    });

    const response = await install("lead-magnet");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Connect Instagram");
  });

  it("creates the tracked link and switches the campaign on when given a URL", async () => {
    const response = await install("lead-magnet", {
      destinationUrl: "https://example.com/guide",
    });

    expect(response.status).toBe(201);
    expect(created[0].isActive).toBe(true);
    expect(created[0].trackedLinks).toEqual({
      create: [
        expect.objectContaining({
          workspaceId: OWN_WORKSPACE,
          destinationUrl: "https://example.com/guide",
        }),
      ],
    });
  });

  it("installs a link template paused when no URL is known yet", async () => {
    const response = await install("lead-magnet");
    const payload = await response.json();

    expect(created[0].isActive).toBe(false);
    expect(created[0].trackedLinks).toBeUndefined();
    expect(payload.data.needsLink).toBe(true);
  });

  it("installs a template that needs no link ready to run", async () => {
    const response = await install("giveaway-entry");
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(created[0].isActive).toBe(true);
    expect(payload.data.needsLink).toBe(false);
  });

  it("carries the default reply template through as a catch-all", async () => {
    await install("faq-deflection");

    expect(created[0].defaultReplyEnabled).toBe(true);
    expect(created[0].dmTriggerEnabled).toBe(true);
    expect(created[0].matchAnyWord).toBe(true);
    expect(created[0].keywords).toEqual([]);
    expect(created[0].matchAnyPost).toBe(false);
  });

  it("carries the welcome template's opening DM through intact", async () => {
    await install("new-follower-welcome");

    const template = getTemplate("new-follower-welcome");
    expect(created[0].referralRef).toBe("welcome");
    expect(created[0].openingDmEnabled).toBe(true);
    expect(created[0].openingDmMessage).toBe(
      template?.preset.openingDmMessage
    );
    expect(created[0].openingDmButtonLabel).toBe(
      template?.preset.openingDmButtonLabel
    );
  });

  it("stores the public reply variations, not just the first one", async () => {
    await install("link-in-bio");

    const template = getTemplate("link-in-bio");
    expect(created[0].publicReplyEnabled).toBe(true);
    expect(created[0].publicReplyMessages).toEqual(
      template?.preset.publicReplyMessages
    );
    expect(created[0].publicReplyMessage).toBe(
      template?.preset.publicReplyMessages[0]
    );
  });
});
