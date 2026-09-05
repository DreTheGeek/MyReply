import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockContext,
  mockGetUserMedia,
  mockSendDirectMessage,
  mockSendDirectMessageWithLinkButton,
} = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    automation: { create: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    contact: { findFirst: vi.fn() },
  },
  mockContext: vi.fn(),
  mockGetUserMedia: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

// The real role ladder, on purpose: the point of the gate is that it is the
// same rule the campaign builder enforces, not a second copy of it.
vi.mock("@/lib/workspace-access", async () => {
  const roles = await import("../lib/roles");
  return {
    getCurrentWorkspaceContext: mockContext,
    canManageWorkspace: roles.canManageWorkspace,
    canManageBilling: roles.canManageBilling,
    hasWorkspaceRole: roles.hasWorkspaceRole,
  };
});

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(async () => OWN_WORKSPACE),
}));

// The token is opaque to every route here, so unwrap it to itself rather than
// standing up a real encryption key.
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (token: string) => token,
}));

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/client")>();
  return {
    ...actual,
    getUserMedia: mockGetUserMedia,
    sendDirectMessage: mockSendDirectMessage,
    sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
  };
});

import { NextRequest } from "next/server";

import { clearOnboardingCache } from "../lib/onboarding/cache";
import type { InstagramMedia } from "../lib/meta/client";
import type { OnboardingDraft, OnboardingSuggestions } from "../lib/onboarding/types";
import { GET as getSuggestions } from "../app/api/onboarding/suggestions/route";
import { POST as activate } from "../app/api/onboarding/activate/route";
import { POST as sendTest } from "../app/api/onboarding/test/route";

const OWN_WORKSPACE = "workspace_own";
const OTHER_WORKSPACE = "workspace_other";

const OWN_ACCOUNT = {
  id: "acct_own",
  workspaceId: OWN_WORKSPACE,
  instagramId: "ig_own",
  username: "lasean",
  accessToken: "token_own",
};

/** Another tenant's account. Nothing in this suite may ever reach it. */
const FOREIGN_ACCOUNT = {
  id: "acct_foreign",
  workspaceId: OTHER_WORKSPACE,
  instagramId: "ig_foreign",
  username: "someoneelse",
  accessToken: "token_foreign",
};

const ACCOUNTS = [OWN_ACCOUNT, FOREIGN_ACCOUNT];

const POSTS: InstagramMedia[] = [
  {
    id: "p1",
    caption: "Pricing starts at $499. Comment PRICE for the breakdown.",
    media_type: "IMAGE",
    timestamp: "2026-03-01T12:00:00+0000",
    permalink: "https://www.instagram.com/p/p1/",
    comments_count: 9,
  },
  {
    id: "p2",
    caption: "Free guide here https://example.com/guide",
    media_type: "IMAGE",
    timestamp: "2026-02-27T12:00:00+0000",
    permalink: "https://www.instagram.com/p/p2/",
  },
  {
    id: "p3",
    caption: "Book a call https://calendly.com/lasean/intro",
    media_type: "IMAGE",
    timestamp: "2026-02-25T12:00:00+0000",
    permalink: "https://www.instagram.com/p/p3/",
  },
];

function asWorkspace(
  workspaceId: string,
  role: "OWNER" | "ADMIN" | "MEMBER" = "OWNER"
): void {
  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId,
    workspace: { id: workspaceId, plan: "FREE" },
    role,
  });
}

function suggestionsRequest(query = ""): Promise<Response> {
  return getSuggestions(
    new NextRequest(`https://myreply.test/api/onboarding/suggestions${query}`)
  );
}

function activateRequest(body: unknown): Promise<Response> {
  return activate(
    new NextRequest("https://myreply.test/api/onboarding/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function testRequest(body: unknown): Promise<Response> {
  return sendTest(
    new NextRequest("https://myreply.test/api/onboarding/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function loadDrafts(): Promise<OnboardingDraft[]> {
  const payload = (await (await suggestionsRequest()).json()) as {
    data: OnboardingSuggestions;
  };
  return payload.data.drafts;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearOnboardingCache();
  asWorkspace(OWN_WORKSPACE);
  mockGetUserMedia.mockResolvedValue(POSTS);

  // The workspace scoping that matters: an account is only ever found when the
  // caller's workspace owns it.
  mockPrisma.instagramAccount.findFirst.mockImplementation(
    async ({ where }: { where: { id?: string; workspaceId: string } }) => {
      const found = ACCOUNTS.find(
        (account) =>
          account.workspaceId === where.workspaceId &&
          (where.id === undefined || account.id === where.id)
      );
      return found ?? null;
    }
  );
  mockPrisma.workspace.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({ id: where.id })
  );
  mockPrisma.automation.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "automation_new",
      ...data,
      trackedLinks: [],
    })
  );
  mockPrisma.contact.findFirst.mockResolvedValue(null);
});

describe("GET /api/onboarding/suggestions", () => {
  it("returns five drafts for the caller's own account", async () => {
    const response = await suggestionsRequest();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.drafts).toHaveLength(5);
    expect(payload.data.account.username).toBe(OWN_ACCOUNT.username);
    expect(mockGetUserMedia).toHaveBeenCalledWith(OWN_ACCOUNT.accessToken, 12);
  });

  it("rejects an unauthenticated caller", async () => {
    mockContext.mockResolvedValue(null);
    expect((await suggestionsRequest()).status).toBe(401);
  });

  it("asks a workspace with no Instagram account to connect one", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    const response = await suggestionsRequest();

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/connect instagram/i);
  });

  it("never builds suggestions from another workspace's account", async () => {
    const response = await suggestionsRequest(
      `?instagramAccountId=${FOREIGN_ACCOUNT.id}`
    );

    expect(response.status).toBe(400);
    expect(mockGetUserMedia).not.toHaveBeenCalled();
  });

  it("serves a repeat load from cache instead of calling Meta twice", async () => {
    await suggestionsRequest();
    await suggestionsRequest();
    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
  });

  it("writes the drafts in the voice the workspace chose", async () => {
    mockContext.mockResolvedValue({
      userId: "user_1",
      workspaceId: OWN_WORKSPACE,
      workspace: { id: OWN_WORKSPACE, plan: "FREE", tone: "PROFESSIONAL" },
      role: "OWNER",
    });
    const professional = await (await suggestionsRequest()).json();

    clearOnboardingCache();
    asWorkspace(OWN_WORKSPACE);
    const friendly = await (await suggestionsRequest()).json();

    expect(professional.data.drafts[0].dmMessage).not.toBe(
      friendly.data.drafts[0].dmMessage
    );
  });

  it("caches each voice separately rather than serving the wrong one", async () => {
    await suggestionsRequest("?tone=friendly");
    await suggestionsRequest("?tone=professional");
    expect(mockGetUserMedia).toHaveBeenCalledTimes(2);
  });

  it("rejects a tone that is not a tone", async () => {
    expect((await suggestionsRequest("?tone=sarcastic")).status).toBe(400);
  });
});

describe("POST /api/onboarding/activate", () => {
  it("turns every draft into a valid campaign through the existing route", async () => {
    const drafts = await loadDrafts();
    expect(drafts).toHaveLength(5);

    for (const draft of drafts) {
      mockPrisma.automation.create.mockClear();

      const response = await activateRequest({
        draftId: draft.id,
        automation: draft.automation,
      });

      expect(
        response.status,
        `draft ${draft.id} was rejected by the create route`
      ).toBe(201);
      expect(mockPrisma.automation.create).toHaveBeenCalledTimes(1);

      const [[created]] = mockPrisma.automation.create.mock.calls;
      expect(created.data.workspaceId).toBe(OWN_WORKSPACE);
      expect(created.data.instagramAccountId).toBe(OWN_ACCOUNT.id);
      expect(created.data.name).toBe(draft.automation.name);
      expect(created.data.dmMessage).toBe(draft.automation.dmMessage);
      expect(created.data.keywords).toEqual(draft.automation.keywords);
      // Live unless the copy points at a link the account has not given us, in
      // which case it installs paused rather than sending a dangling sentence.
      expect(created.data.isActive).toBe(!draft.needsLink);
    }
  });

  it("carries the draft's public reply variations onto the campaign", async () => {
    const [draft] = await loadDrafts();

    await activateRequest({ draftId: draft.id, automation: draft.automation });

    const [[created]] = mockPrisma.automation.create.mock.calls;
    expect(created.data.publicReplyEnabled).toBe(true);
    expect(created.data.publicReplyMessages).toEqual(
      draft.publicReplyMessages
    );
  });

  it("creates the tracked link a draft took from the caption", async () => {
    const drafts = await loadDrafts();
    const linked = drafts.find(
      (draft) => draft.automation.trackedDestinationUrl !== null
    );
    expect(linked).toBeDefined();
    if (!linked) return;

    await activateRequest({ draftId: linked.id, automation: linked.automation });

    const [[created]] = mockPrisma.automation.create.mock.calls;
    expect(created.data.trackedLinks.create[0].destinationUrl).toBe(
      linked.automation.trackedDestinationUrl
    );
    expect(created.data.trackedLinks.create[0].workspaceId).toBe(OWN_WORKSPACE);
  });

  it("rejects an unauthenticated caller", async () => {
    const [draft] = await loadDrafts();
    mockContext.mockResolvedValue(null);

    expect(
      (await activateRequest({ draftId: draft.id, automation: draft.automation }))
        .status
    ).toBe(401);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("refuses a draft that names another workspace's account", async () => {
    const [draft] = await loadDrafts();

    const response = await activateRequest({
      draftId: draft.id,
      instagramAccountId: FOREIGN_ACCOUNT.id,
      automation: draft.automation,
    });

    expect(response.status).toBe(400);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("ignores an account id smuggled inside the campaign payload", async () => {
    const [draft] = await loadDrafts();

    const response = await activateRequest({
      draftId: draft.id,
      automation: {
        ...draft.automation,
        instagramAccountId: FOREIGN_ACCOUNT.id,
      },
    });

    expect(response.status).toBe(201);
    const [[created]] = mockPrisma.automation.create.mock.calls;
    expect(created.data.instagramAccountId).toBe(OWN_ACCOUNT.id);
  });

  it("cannot be used to write a campaign into another workspace", async () => {
    const [draft] = await loadDrafts();

    const response = await activateRequest({
      draftId: draft.id,
      automation: { ...draft.automation, workspaceId: OTHER_WORKSPACE },
    });

    expect(response.status).toBe(201);
    const [[created]] = mockPrisma.automation.create.mock.calls;
    expect(created.data.workspaceId).toBe(OWN_WORKSPACE);
  });

  it("rejects a body that is not a draft at all", async () => {
    expect((await activateRequest({ nope: true })).status).toBe(400);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("lets a member's draft be refused by the create route's own role gate", async () => {
    const drafts = await loadDrafts();
    asWorkspace(OWN_WORKSPACE, "MEMBER");

    const response = await activateRequest({
      draftId: drafts[0].id,
      automation: drafts[0].automation,
    });

    expect(response.status).toBe(403);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/test", () => {
  const CAMPAIGN = {
    id: "automation_1",
    workspaceId: OWN_WORKSPACE,
    dmMessage: "Hey {username}, here it is.",
    linkButtonLabel: null,
    instagramAccount: {
      id: OWN_ACCOUNT.id,
      instagramId: OWN_ACCOUNT.instagramId,
      username: OWN_ACCOUNT.username,
      accessToken: OWN_ACCOUNT.accessToken,
    },
    trackedLinks: [],
  };

  beforeEach(() => {
    mockPrisma.automation.findFirst.mockImplementation(
      async ({ where }: { where: { id: string; workspaceId: string } }) =>
        where.id === CAMPAIGN.id && where.workspaceId === OWN_WORKSPACE
          ? CAMPAIGN
          : null
    );
  });

  it("sends the campaign's own DM to whoever has an open window", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({
      externalId: "igsid_owner",
      username: "lasean_personal",
    });

    const response = await testRequest({ automationId: CAMPAIGN.id });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.status).toBe("sent");
    expect(payload.data.sentTo).toBe("lasean_personal");
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      OWN_ACCOUNT.accessToken,
      OWN_ACCOUNT.instagramId,
      "igsid_owner",
      "Hey lasean_personal, here it is."
    );
  });

  it("explains the closed 24 hour window in plain language rather than failing", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue(null);

    const response = await testRequest({ automationId: CAMPAIGN.id });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.status).toBe("window_closed");
    expect(payload.data.message).toContain("24 hours");
    expect(payload.data.message).toContain(`@${OWN_ACCOUNT.username}`);
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("says the same thing when Meta itself refuses on the window", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({
      externalId: "igsid_owner",
      username: "lasean_personal",
    });
    mockSendDirectMessage.mockRejectedValue(
      new Error("This message is sent outside of allowed window.")
    );

    const payload = await (await testRequest({ automationId: CAMPAIGN.id })).json();

    expect(payload.success).toBe(true);
    expect(payload.data.status).toBe("window_closed");
  });

  it("only looks for a contact inside the 24 hour window", async () => {
    await testRequest({ automationId: CAMPAIGN.id });

    const [[query]] = mockPrisma.contact.findFirst.mock.calls;
    expect(query.where.workspaceId).toBe(OWN_WORKSPACE);
    expect(query.where.instagramAccountId).toBe(OWN_ACCOUNT.id);

    const cutoff: Date = query.where.lastSeenAt.gte;
    const hoursAgo = (Date.now() - cutoff.getTime()) / 3_600_000;
    expect(hoursAgo).toBeGreaterThan(23.9);
    expect(hoursAgo).toBeLessThan(24.1);
  });

  it("cannot send a test for another workspace's campaign", async () => {
    asWorkspace(OTHER_WORKSPACE);

    const response = await testRequest({ automationId: CAMPAIGN.id });

    expect(response.status).toBe(404);
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    mockContext.mockResolvedValue(null);
    expect((await testRequest({ automationId: CAMPAIGN.id })).status).toBe(401);
  });

  it("refuses a member, matching the campaign routes' own gate", async () => {
    asWorkspace(OWN_WORKSPACE, "MEMBER");
    expect((await testRequest({ automationId: CAMPAIGN.id })).status).toBe(403);
  });
});
