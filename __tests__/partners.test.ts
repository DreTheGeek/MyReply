/**
 * Partner apps: a partner creates and owns workspaces for its own users, and
 * can never see or touch another partner's. The workspace store below is a
 * small in-memory table that honours the same where clauses Prisma would, so
 * the tenancy assertions run against real filtering rather than canned answers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface WorkspaceRow {
  id: string;
  name: string;
  partnerId: string | null;
  externalId: string | null;
  timezone: string;
  plan: string;
  createdAt: Date;
}

const { mockPrisma, mockResolvePartner, mockResolveApiKey, mockCarriesPartner, mockConsume, mockAudit } =
  vi.hoisted(() => ({
    mockPrisma: {
      workspace: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      partner: { findUnique: vi.fn(), findFirst: vi.fn() },
      partnerApiKey: { findUnique: vi.fn(), update: vi.fn() },
      automation: { count: vi.fn() },
      workspaceMember: { findFirst: vi.fn() },
    },
    mockResolvePartner: vi.fn(),
    mockResolveApiKey: vi.fn(),
    mockCarriesPartner: vi.fn(),
    mockConsume: vi.fn(),
    mockAudit: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  resolveRequestPartner: mockResolvePartner,
  resolveRequestApiKey: mockResolveApiKey,
  requestCarriesPartnerKey: mockCarriesPartner,
  auth: vi.fn(async () => null),
}));
vi.mock("@/lib/api/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api/rate-limit")>()),
  consumeCredentialRequest: mockConsume,
}));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: mockAudit }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(),
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { NextRequest } from "next/server";
import { GET as listWorkspaces, POST as createWorkspace } from "../app/api/v1/workspaces/route";
import {
  DELETE as deleteWorkspace,
  GET as getWorkspace,
  PATCH as patchWorkspace,
} from "../app/api/v1/workspaces/[id]/route";
import { POST as createConnectLink } from "../app/api/v1/workspaces/[id]/connect-links/route";
import { requireApiKey, isRejection } from "../lib/api/v1";
import {
  extractPartnerKey,
  generatePartnerKey,
  partnerWorkspaceContext,
  resolvePartnerKey,
} from "../lib/partners/keys";
import {
  createHostedToken,
  isAllowedReturnUrl,
  normalizeOrigin,
  returnUrlWithOutcome,
  verifyHostedToken,
} from "../lib/partners/links";
import { accountStatus } from "../lib/partners/workspaces";
import { mayFinishConnect, connectOutcomeUrl } from "../lib/channels/connect-authorize";
import { createOAuthState, verifyOAuthState } from "../lib/security/oauth-state";

const LASH = { partnerId: "partner_lash", keyId: "pkey_lash", scopes: [], credentialId: "partner:pkey_lash" };
const OTHER = { partnerId: "partner_other", keyId: "pkey_other", scopes: [], credentialId: "partner:pkey_other" };
const ALL_SCOPES = [
  "accounts:read",
  "campaigns:read",
  "campaigns:write",
  "workspaces:read",
  "workspaces:write",
];

let rows: WorkspaceRow[] = [];

function matches(row: WorkspaceRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, value]) => {
    if (field === "partner") return true;
    return (row as unknown as Record<string, unknown>)[field] === value;
  });
}

function seed(partial: Partial<WorkspaceRow> & { id: string }): WorkspaceRow {
  const row: WorkspaceRow = {
    name: partial.id,
    partnerId: null,
    externalId: null,
    timezone: "UTC",
    plan: "FREE",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...partial,
  };
  rows.push(row);
  return row;
}

function project(row: WorkspaceRow): Record<string, unknown> {
  return { ...row, instagramAccounts: [] };
}

function request(path: string, init: { method?: string; body?: unknown } = {}): NextRequest {
  return new NextRequest(`https://myreply.test${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = <T,>(value: T): { params: Promise<T> } => ({ params: Promise.resolve(value) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "partner-test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://myreply.test");
  rows = [];
  seed({ id: "ws_lash_1", partnerId: "partner_lash", externalId: "studio-1" });
  seed({ id: "ws_other_1", partnerId: "partner_other", externalId: "studio-1" });
  seed({ id: "ws_direct", partnerId: null });

  mockResolvePartner.mockResolvedValue({ ...LASH, scopes: ALL_SCOPES });
  mockResolveApiKey.mockResolvedValue(null);
  mockCarriesPartner.mockResolvedValue(false);
  mockConsume.mockResolvedValue({ status: "allowed", remaining: 100 });
  mockAudit.mockResolvedValue(undefined);

  mockPrisma.workspace.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const row = rows.find((candidate) => matches(candidate, where));
    return row ? project(row) : null;
  });
  mockPrisma.workspace.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    rows.filter((row) => matches(row, where)).map(project)
  );
  mockPrisma.workspace.create.mockImplementation(async ({ data }: { data: Partial<WorkspaceRow> }) => {
    const row = seed({ id: `ws_new_${rows.length}`, ...data });
    return project(row);
  });
  mockPrisma.workspace.updateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Partial<WorkspaceRow> }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    }
  );
  mockPrisma.workspace.deleteMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const before = rows.length;
    rows = rows.filter((row) => !matches(row, where));
    return { count: before - rows.length };
  });
  mockPrisma.partner.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    workspacePlan: "PRO",
    returnOrigins: ["https://lashtech.app"],
    frameOrigins: ["https://lashtech.app"],
    customDomain: where.id === "partner_lash" ? "connect.lashtech.app" : null,
  }));
  mockPrisma.automation.count.mockResolvedValue(0);
});

describe("partner keys", () => {
  it("are prefixed, hashed and told apart from workspace keys", () => {
    const key = generatePartnerKey();
    expect(key.plaintext.startsWith("mr_partner_")).toBe(true);
    expect(key.hashedKey).toMatch(/^[a-f0-9]{64}$/);
    expect(extractPartnerKey(`Bearer ${key.plaintext}`)).toBe(key.plaintext);
    expect(extractPartnerKey("Bearer mr_live_abc")).toBeNull();
  });

  it("refuse a revoked key, an expired key and any key of a disabled partner", async () => {
    const base = {
      id: "pkey_1",
      partnerId: "partner_lash",
      scopes: [],
      revokedAt: null,
      expiresAt: null,
      partner: { disabledAt: null },
    };
    mockPrisma.partnerApiKey.findUnique.mockResolvedValueOnce(base);
    expect(await resolvePartnerKey("mr_partner_x")).toMatchObject({ partnerId: "partner_lash" });

    mockPrisma.partnerApiKey.findUnique.mockResolvedValueOnce({ ...base, revokedAt: new Date() });
    expect(await resolvePartnerKey("mr_partner_x")).toBeNull();

    mockPrisma.partnerApiKey.findUnique.mockResolvedValueOnce({ ...base, expiresAt: new Date(0) });
    expect(await resolvePartnerKey("mr_partner_x")).toBeNull();

    mockPrisma.partnerApiKey.findUnique.mockResolvedValueOnce({
      ...base,
      partner: { disabledAt: new Date() },
    });
    expect(await resolvePartnerKey("mr_partner_x")).toBeNull();
  });

  it("act inside the partner's own workspace and no other", async () => {
    const own = await partnerWorkspaceContext({ ...LASH, scopes: [] }, "ws_lash_1");
    expect(own).toMatchObject({
      workspaceId: "ws_lash_1",
      kind: "partner",
      partnerId: "partner_lash",
      role: "ADMIN",
      credentialId: "partner:pkey_lash:ws_lash_1",
    });
    expect(await partnerWorkspaceContext({ ...LASH, scopes: [] }, "ws_other_1")).toBeNull();
    expect(await partnerWorkspaceContext({ ...LASH, scopes: [] }, "ws_direct")).toBeNull();
    expect(await partnerWorkspaceContext({ ...LASH, scopes: [] }, "ws_nope")).toBeNull();
  });

  it("tell a partner key that named no workspace of its own where to put the id", async () => {
    mockCarriesPartner.mockResolvedValue(true);
    const caller = await requireApiKey("campaigns:read");
    expect(isRejection(caller) && caller.status).toBe(404);
    if (!isRejection(caller)) return;
    expect((await caller.json()).error).toMatch(/X-Workspace-Id/);
  });
});

describe("creating and listing workspaces", () => {
  it("creates a workspace owned by the partner, on the partner's plan", async () => {
    const response = await createWorkspace(
      request("/api/v1/workspaces", { method: "POST", body: { name: "Bella Lashes", externalId: "studio-9" } }),
      params({})
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({ name: "Bella Lashes", externalId: "studio-9", created: true });
    expect(rows.find((row) => row.externalId === "studio-9")).toMatchObject({
      partnerId: "partner_lash",
      plan: "PRO",
    });
  });

  it("returns the first workspace when the same externalId is sent again", async () => {
    const response = await createWorkspace(
      request("/api/v1/workspaces", { method: "POST", body: { name: "Again", externalId: "studio-1" } }),
      params({})
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id: "ws_lash_1", created: false });
    // The other partner's studio-1 is a different workspace and was not returned.
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
  });

  it("refuses unknown fields and a bad timezone", async () => {
    for (const body of [{ name: "x", partnerId: "partner_other" }, { name: "x", timezone: "Mars/Base" }, {}]) {
      const response = await createWorkspace(request("/api/v1/workspaces", { method: "POST", body }), params({}));
      expect(response.status).toBe(400);
    }
  });

  it("lists only the partner's own workspaces", async () => {
    const response = await listWorkspaces(request("/api/v1/workspaces"), params({}));
    const ids = (await response.json()).data.workspaces.map((workspace: { id: string }) => workspace.id);
    expect(ids).toEqual(["ws_lash_1"]);
  });

  it("is closed to a workspace key and to a key without the scope", async () => {
    mockResolvePartner.mockResolvedValue(null);
    expect((await listWorkspaces(request("/api/v1/workspaces"), params({}))).status).toBe(401);

    mockResolvePartner.mockResolvedValue({ ...LASH, scopes: ["workspaces:read"] });
    const write = await createWorkspace(
      request("/api/v1/workspaces", { method: "POST", body: { name: "x" } }),
      params({})
    );
    expect(write.status).toBe(403);
  });
});

describe("one partner can never reach another's workspace", () => {
  it("reads, changes, deletes and links only its own", async () => {
    mockResolvePartner.mockResolvedValue({ ...OTHER, scopes: ALL_SCOPES });

    expect((await getWorkspace(request("/api/v1/workspaces/ws_lash_1"), params({ id: "ws_lash_1" }))).status).toBe(404);
    expect(
      (
        await patchWorkspace(
          request("/api/v1/workspaces/ws_lash_1", { method: "PATCH", body: { name: "Mine now" } }),
          params({ id: "ws_lash_1" })
        )
      ).status
    ).toBe(404);
    expect(
      (await deleteWorkspace(request("/api/v1/workspaces/ws_lash_1", { method: "DELETE" }), params({ id: "ws_lash_1" })))
        .status
    ).toBe(404);
    expect(
      (
        await createConnectLink(
          request("/api/v1/workspaces/ws_lash_1/connect-links", {
            method: "POST",
            body: { returnUrl: "https://lashtech.app/done" },
          }),
          params({ id: "ws_lash_1" })
        )
      ).status
    ).toBe(404);

    expect(rows.find((row) => row.id === "ws_lash_1")).toMatchObject({ name: "ws_lash_1" });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("cannot reach a workspace made by someone signed in directly", async () => {
    const response = await getWorkspace(request("/api/v1/workspaces/ws_direct"), params({ id: "ws_direct" }));
    expect(response.status).toBe(404);
  });

  it("deletes its own workspace and leaves an audit row", async () => {
    const response = await deleteWorkspace(
      request("/api/v1/workspaces/ws_lash_1", { method: "DELETE" }),
      params({ id: "ws_lash_1" })
    );
    expect(response.status).toBe(200);
    expect(rows.find((row) => row.id === "ws_lash_1")).toBeUndefined();
    expect(rows.find((row) => row.id === "ws_other_1")).toBeDefined();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.deleted", targetId: "ws_lash_1" })
    );
  });

  it("refuses an externalId another of its workspaces already uses", async () => {
    seed({ id: "ws_lash_2", partnerId: "partner_lash", externalId: "studio-2" });
    const { Prisma } = await import("../app/generated/prisma/client");
    mockPrisma.workspace.updateMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" })
    );
    const response = await patchWorkspace(
      request("/api/v1/workspaces/ws_lash_2", { method: "PATCH", body: { externalId: "studio-1" } }),
      params({ id: "ws_lash_2" })
    );
    expect(response.status).toBe(409);
  });
});

describe("connect links", () => {
  it("are minted only for an allowed https return origin", async () => {
    for (const returnUrl of [
      "https://evil.example/phish",
      "http://lashtech.app/done",
      "https://lashtech.app.evil.example/done",
    ]) {
      const response = await createConnectLink(
        request("/api/v1/workspaces/ws_lash_1/connect-links", { method: "POST", body: { returnUrl } }),
        params({ id: "ws_lash_1" })
      );
      expect(response.status, returnUrl).toBe(400);
    }
  });

  it("carry a signed token naming the workspace, served from the partner's own domain", async () => {
    const response = await createConnectLink(
      request("/api/v1/workspaces/ws_lash_1/connect-links", {
        method: "POST",
        body: { returnUrl: "https://lashtech.app/settings/social", platforms: ["instagram"] },
      }),
      params({ id: "ws_lash_1" })
    );
    expect(response.status).toBe(201);
    const { url } = (await response.json()).data as { url: string };
    expect(url.startsWith("https://connect.lashtech.app/hosted/connect/")).toBe(true);

    const token = decodeURIComponent(url.split("/hosted/connect/")[1]);
    expect(verifyHostedToken(token, "connect")).toMatchObject({
      w: "ws_lash_1",
      p: "partner_lash",
      r: "https://lashtech.app/settings/social",
      pl: ["instagram"],
      fa: ["https://lashtech.app"],
    });
  });
});

describe("hosted tokens", () => {
  const claims = { k: "connect" as const, w: "ws_1", p: "partner_lash", fa: [] };

  it("refuse an edited token, the wrong kind and an expired one", () => {
    const { token } = createHostedToken(claims, 10);
    expect(verifyHostedToken(token, "connect")).not.toBeNull();
    expect(verifyHostedToken(token, "inbox")).toBeNull();
    expect(verifyHostedToken(token, "connect", Date.now() + 11 * 60_000)).toBeNull();

    const [payload, signature] = token.split(".");
    const edited = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), w: "ws_2" })
    ).toString("base64url");
    expect(verifyHostedToken(`${edited}.${signature}`, "connect")).toBeNull();
    expect(verifyHostedToken("garbage", "connect")).toBeNull();
    expect(verifyHostedToken(`${token}.extra`, "connect")).toBeNull();
  });

  it("never outlive the longest a kind allows", () => {
    const { expiresAt } = createHostedToken(claims, 10_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 1000);
  });

  it("cannot be replayed as an OAuth state", () => {
    const { token } = createHostedToken(claims, 10);
    expect(verifyOAuthState(token)).toBeNull();
  });
});

describe("origins and return URLs", () => {
  it("accept only a bare https origin", () => {
    expect(normalizeOrigin("https://lashtech.app")).toBe("https://lashtech.app");
    expect(normalizeOrigin("https://lashtech.app/")).toBe("https://lashtech.app");
    expect(normalizeOrigin("http://lashtech.app")).toBeNull();
    expect(normalizeOrigin("https://lashtech.app/path")).toBeNull();
    expect(normalizeOrigin("https://*.lashtech.app")).toBeNull();
    expect(normalizeOrigin("https://user:pass@lashtech.app")).toBeNull();
  });

  it("match a return URL on its exact origin", () => {
    expect(isAllowedReturnUrl("https://lashtech.app/x?y=1", ["https://lashtech.app"])).toBe(true);
    expect(isAllowedReturnUrl("https://www.lashtech.app/x", ["https://lashtech.app"])).toBe(false);
  });

  it("put the outcome on the partner's URL without dropping its own query", () => {
    const url = new URL(
      returnUrlWithOutcome("https://lashtech.app/done?tab=social", {
        status: "connected",
        platform: "instagram",
        workspaceId: "ws_1",
        connected: 1,
      })
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tab: "social",
      connect_status: "connected",
      platform: "instagram",
      workspace_id: "ws_1",
      connected: "1",
    });
  });
});

describe("finishing a hosted connect", () => {
  it("carries the partner and return URL through the OAuth state, and refuses a malformed one", () => {
    const state = createOAuthState("ws_lash_1", {
      partnerId: "partner_lash",
      returnUrl: "https://lashtech.app/done",
    });
    expect(verifyOAuthState(state)).toMatchObject({
      workspaceId: "ws_lash_1",
      hosted: { partnerId: "partner_lash", returnUrl: "https://lashtech.app/done" },
    });

    const plain = verifyOAuthState(createOAuthState("ws_x"));
    expect(plain?.hosted).toBeUndefined();
  });

  it("is allowed without a session only for the partner's own workspace", async () => {
    expect(
      await mayFinishConnect({
        workspaceId: "ws_lash_1",
        hosted: { partnerId: "partner_lash", returnUrl: "https://lashtech.app/done" },
      })
    ).toBe("ok");
    expect(
      await mayFinishConnect({
        workspaceId: "ws_other_1",
        hosted: { partnerId: "partner_lash", returnUrl: "https://lashtech.app/done" },
      })
    ).toBe("forbidden");
    // Without the hosted block a session is required, and there is none.
    expect(await mayFinishConnect({ workspaceId: "ws_lash_1" })).toBe("login");
  });

  it("sends a hosted connect back to the partner and everyone else to settings", () => {
    const hosted = connectOutcomeUrl(
      {
        workspaceId: "ws_lash_1",
        hosted: { partnerId: "partner_lash", returnUrl: "https://lashtech.app/done" },
      },
      { platformKey: "instagram", status: "denied" }
    );
    expect(hosted).toBe(
      "https://lashtech.app/done?connect_status=denied&platform=instagram&workspace_id=ws_lash_1"
    );
    expect(connectOutcomeUrl({ workspaceId: "ws_1" }, { platformKey: "facebook", status: "connected", connected: 2 })).toBe(
      "https://myreply.test/settings?facebook=connected&count=2"
    );
  });
});

describe("account status", () => {
  const now = new Date("2026-11-11T00:00:00Z");
  it("reads an erased or expired token as needing a reconnect", () => {
    expect(accountStatus({ accessToken: "", tokenExpiresAt: null, webhookSubscribed: true }, now)).toBe(
      "needs_reconnect"
    );
    expect(
      accountStatus({ accessToken: "x", tokenExpiresAt: new Date("2026-11-10T00:00:00Z"), webhookSubscribed: true }, now)
    ).toBe("needs_reconnect");
    expect(accountStatus({ accessToken: "x", tokenExpiresAt: null, webhookSubscribed: false }, now)).toBe(
      "events_off"
    );
    expect(accountStatus({ accessToken: "x", tokenExpiresAt: null, webhookSubscribed: true }, now)).toBe(
      "connected"
    );
  });
});
