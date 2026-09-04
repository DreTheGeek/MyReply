import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext, mockCanManage } = vi.hoisted(() => ({
  mockPrisma: {
    apiKey: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
  mockContext: vi.fn(),
  mockCanManage: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

const ROLE_ORDER: Record<string, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

// canManageWorkspace goes through a mock so one test can loosen the write gate
// and prove the role ceiling holds on its own rather than by coincidence.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string): boolean => mockCanManage(role),
  hasWorkspaceRole: (role: string, minimumRole: string): boolean =>
    ROLE_ORDER[role] >= ROLE_ORDER[minimumRole],
}));

import { NextRequest } from "next/server";

import { hashApiKey, resolveApiKey } from "../lib/api-keys";
import { DELETE, GET, POST } from "../app/api/workspace/api-keys/route";

const URL_BASE = "https://myreply.test/api/workspace/api-keys";
const OWN_WORKSPACE = "workspace_ours";
const OTHER_WORKSPACE = "workspace_theirs";

/** A stored row, as Prisma would hold it. Includes the hash on purpose. */
interface StoredKey {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  hashedKey: string;
  role: string;
  createdByUserId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

let store: StoredKey[] = [];

/** Mimics Prisma's `select`, so a field the route forgets to exclude leaks. */
function project(
  row: StoredKey,
  select: Record<string, boolean> | undefined
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) out[field] = (row as unknown as Record<string, unknown>)[field];
  }
  return out;
}

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function del(body: unknown): Promise<Response> {
  return DELETE(
    new NextRequest(URL_BASE, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function asRole(role: "OWNER" | "ADMIN" | "MEMBER", workspaceId = OWN_WORKSPACE): void {
  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId,
    workspace: { id: workspaceId },
    role,
  });
}

/** Drops a row straight into the store, bypassing the route. */
function seed(overrides: Partial<StoredKey> & { hashedKey: string }): StoredKey {
  const row: StoredKey = {
    id: `key_seed_${store.length + 1}`,
    workspaceId: OWN_WORKSPACE,
    name: "Seeded",
    prefix: "mr_live_seeded",
    role: "ADMIN",
    createdByUserId: null,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
  store.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
  asRole("OWNER");
  mockCanManage.mockImplementation(
    (role: string) => role === "OWNER" || role === "ADMIN"
  );

  mockPrisma.apiKey.create.mockImplementation(
    async ({
      data,
      select,
    }: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => {
      const row: StoredKey = {
        id: `key_${store.length + 1}`,
        workspaceId: "",
        name: "",
        prefix: "",
        hashedKey: "",
        role: "ADMIN",
        createdByUserId: null,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date("2026-02-01"),
        updatedAt: new Date("2026-02-01"),
        ...(data as unknown as Partial<StoredKey>),
      };
      store.push(row);
      return project(row, select);
    }
  );

  mockPrisma.apiKey.findMany.mockImplementation(
    async ({
      where,
      select,
    }: {
      where: { workspaceId: string };
      select?: Record<string, boolean>;
    }) =>
      store
        .filter((row) => row.workspaceId === where.workspaceId)
        .map((row) => project(row, select))
  );

  mockPrisma.apiKey.findUnique.mockImplementation(
    async ({
      where,
      select,
    }: {
      where: { hashedKey: string };
      select?: Record<string, boolean>;
    }) => {
      const row = store.find((entry) => entry.hashedKey === where.hashedKey);
      return row ? project(row, select) : null;
    }
  );

  mockPrisma.apiKey.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string; workspaceId: string; revokedAt: null };
      data: Record<string, unknown>;
    }) => {
      const matches = store.filter(
        (row) =>
          row.id === where.id &&
          row.workspaceId === where.workspaceId &&
          row.revokedAt === null
      );
      for (const row of matches) Object.assign(row, data);
      return { count: matches.length };
    }
  );
});

describe("the plaintext key is shown exactly once", () => {
  it("returns it from create, and never persists it", async () => {
    const created = await (await post({ name: "Claude on my laptop" })).json();

    const plaintext: string = created.data.key;
    expect(plaintext.startsWith("mr_live_")).toBe(true);

    // What went to the database is the hash, not the key.
    const stored = store[0];
    expect(stored.hashedKey).toBe(hashApiKey(plaintext));
    expect(JSON.stringify(stored)).not.toContain(plaintext);
  });

  it("never repeats it in a list, and never lists the hash either", async () => {
    const created = await (await post({ name: "Import job" })).json();
    const plaintext: string = created.data.key;

    const listed = await (await GET()).json();
    const body = JSON.stringify(listed);

    expect(body).not.toContain(plaintext);
    expect(body).not.toContain(store[0].hashedKey);
    expect(listed.data.keys[0]).toMatchObject({
      name: "Import job",
      prefix: store[0].prefix,
      role: "ADMIN",
    });
    expect(listed.data.keys[0]).not.toHaveProperty("key");
    expect(listed.data.keys[0]).not.toHaveProperty("hashedKey");
  });

  it("lists the metadata a dashboard needs and nothing more", async () => {
    await post({ name: "Reporting" });
    const listed = await (await GET()).json();

    expect(Object.keys(listed.data.keys[0]).sort()).toEqual(
      [
        "createdAt",
        "expiresAt",
        "id",
        "lastUsedAt",
        "name",
        "prefix",
        "revokedAt",
        "role",
      ].sort()
    );
  });
});

describe("optional expiry", () => {
  it("stores no expiry when none is asked for", async () => {
    await post({ name: "Forever" });
    expect(store[0].expiresAt).toBeNull();
  });

  it("stores an expiry the requested number of days out", async () => {
    await post({ name: "Short lived", expiresInDays: 30 });

    const expiresAt = store[0].expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);
    const days = (expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("rejects an absurd expiry rather than storing it", async () => {
    const response = await post({ name: "Too long", expiresInDays: 99_999 });
    expect(response.status).toBe(400);
    expect(store).toHaveLength(0);
  });

  it("rejects a nameless key", async () => {
    const response = await post({ name: "   " });
    expect(response.status).toBe(400);
    expect(store).toHaveLength(0);
  });
});

describe("revoke is workspace scoped", () => {
  it("revokes a key belonging to the caller's workspace", async () => {
    const created = await (await post({ name: "Retired" })).json();

    const response = await del({ id: created.data.id });

    expect(response.status).toBe(200);
    expect(store[0].revokedAt).toBeInstanceOf(Date);
  });

  it("stamps revokedAt rather than deleting the row, so the trail survives", async () => {
    const created = await (await post({ name: "Audited" })).json();
    await del({ id: created.data.id });

    expect(store).toHaveLength(1);
    expect(store[0].name).toBe("Audited");
    expect(store[0].lastUsedAt).toBeNull();
  });

  it("returns 404 and revokes nothing for another tenant's key id", async () => {
    const foreign = seed({
      id: "key_theirs",
      workspaceId: OTHER_WORKSPACE,
      hashedKey: hashApiKey("mr_live_not_a_real_key_theirs"),
    });

    const response = await del({ id: foreign.id });

    expect(response.status).toBe(404);
    expect(foreign.revokedAt).toBeNull();
  });

  it("scopes the update by workspace, not by id alone", async () => {
    const created = await (await post({ name: "Scoped" })).json();
    await del({ id: created.data.id });

    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: {
        id: created.data.id,
        workspaceId: OWN_WORKSPACE,
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("returns 404 for an id that does not exist at all", async () => {
    const response = await del({ id: "key_imaginary" });
    expect(response.status).toBe(404);
  });

  it("requires an id", async () => {
    const response = await del({});
    expect(response.status).toBe(400);
    expect(mockPrisma.apiKey.updateMany).not.toHaveBeenCalled();
  });
});

describe("role gating", () => {
  it("lets an admin create and revoke", async () => {
    asRole("ADMIN");
    const created = await (await post({ name: "Admin made" })).json();
    expect(created.success).toBe(true);
    expect((await del({ id: created.data.id })).status).toBe(200);
  });

  it("refuses a member's create", async () => {
    asRole("MEMBER");

    const response = await post({ name: "Sneaky" });

    expect(response.status).toBe(403);
    expect(mockPrisma.apiKey.create).not.toHaveBeenCalled();
    expect(store).toHaveLength(0);
  });

  it("refuses a member's revoke", async () => {
    const created = await (await post({ name: "Live integration" })).json();
    asRole("MEMBER");

    const response = await del({ id: created.data.id });

    expect(response.status).toBe(403);
    expect(mockPrisma.apiKey.updateMany).not.toHaveBeenCalled();
    expect(store[0].revokedAt).toBeNull();
  });

  it("lets a member read the list, so the screen is not simply blank", async () => {
    await post({ name: "Visible" });
    asRole("MEMBER");

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.keys).toHaveLength(1);
    expect(payload.data.currentUserRole).toBe("MEMBER");
  });

  it("rejects an unauthenticated caller on every verb", async () => {
    mockContext.mockResolvedValue(null);

    expect((await GET()).status).toBe(401);
    expect((await post({ name: "Anon" })).status).toBe(401);
    expect((await del({ id: "key_1" })).status).toBe(401);
  });
});

describe("a key can never carry more access than its creator", () => {
  it("refuses a MEMBER minting an ADMIN key even if the write gate is loosened", async () => {
    // The gate would normally stop a member well before this check. Loosening
    // it here is the point: the ceiling must hold on its own, so that a future
    // change to who may create keys cannot quietly become an escalation.
    mockCanManage.mockReturnValue(true);
    asRole("MEMBER");

    const response = await post({ name: "Escalation attempt", role: "ADMIN" });

    expect(response.status).toBe(403);
    expect(mockPrisma.apiKey.create).not.toHaveBeenCalled();
    expect(store).toHaveLength(0);
  });

  it("still lets a MEMBER mint a MEMBER key at its own level", async () => {
    mockCanManage.mockReturnValue(true);
    asRole("MEMBER");

    const response = await post({ name: "Same level", role: "MEMBER" });

    expect(response.status).toBe(200);
    expect(store[0].role).toBe("MEMBER");
  });

  it("lets an admin mint at or below its own level", async () => {
    asRole("ADMIN");

    await post({ name: "Admin key", role: "ADMIN" });
    await post({ name: "Member key", role: "MEMBER" });

    expect(store.map((row) => row.role)).toEqual(["ADMIN", "MEMBER"]);
  });

  it("refuses an OWNER role outright, since keys stop at admin", async () => {
    const response = await post({ name: "Owner key", role: "OWNER" });

    expect(response.status).toBe(400);
    expect(store).toHaveLength(0);
  });

  it("defaults to ADMIN when no role is asked for", async () => {
    await post({ name: "Default" });
    expect(store[0].role).toBe("ADMIN");
  });
});

describe("resolveApiKey refuses a key the screen has retired", () => {
  it("resolves a freshly created key", async () => {
    const created = await (await post({ name: "Fresh" })).json();

    await expect(resolveApiKey(created.data.key)).resolves.toMatchObject({
      workspaceId: OWN_WORKSPACE,
      role: "ADMIN",
    });
  });

  it("rejects a key once it has been revoked through the route", async () => {
    const created = await (await post({ name: "Doomed" })).json();
    await del({ id: created.data.id });

    await expect(resolveApiKey(created.data.key)).resolves.toBeNull();
  });

  it("rejects a key whose expiry has passed", async () => {
    const created = await (await post({ name: "Lapsed", expiresInDays: 1 })).json();
    // Stand in for the day going by, rather than waiting for it.
    store[0].expiresAt = new Date(Date.now() - 1000);

    await expect(resolveApiKey(created.data.key)).resolves.toBeNull();
  });

  it("still accepts a key whose expiry is ahead of it", async () => {
    const created = await (await post({ name: "Valid", expiresInDays: 30 })).json();

    await expect(resolveApiKey(created.data.key)).resolves.toMatchObject({
      workspaceId: OWN_WORKSPACE,
    });
  });

  it("rejects a key that was never issued", async () => {
    await expect(
      resolveApiKey("mr_live_this_key_is_fake_and_was_never_issued")
    ).resolves.toBeNull();
  });
});
