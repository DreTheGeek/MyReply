import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext, mockCanManage, mockValidate } = vi.hoisted(
  () => ({
    mockPrisma: {
      workspaceAiCredential: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
        updateMany: vi.fn(),
      },
      // Consulted only when there is no BYOK row, to decide whether the
      // workspace's plan entitles it to the managed key.
      workspace: { findUnique: vi.fn() },
    },
    mockContext: vi.fn(),
    mockCanManage: vi.fn(),
    mockValidate: vi.fn(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

const ROLE_ORDER: Record<string, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

// canManageWorkspace goes through a mock so a test can loosen the write gate
// and prove the role ceiling holds on its own rather than by coincidence.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string): boolean => mockCanManage(role),
  hasWorkspaceRole: (role: string, minimumRole: string): boolean =>
    ROLE_ORDER[role] >= ROLE_ORDER[minimumRole],
}));

// The route's own validation call is stubbed so the suite never touches a
// provider. The real implementation is exercised separately with a fake fetch.
vi.mock("@/lib/ai/client", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/ai/client")>("../lib/ai/client");
  return { ...actual, validateProviderKey: mockValidate };
});

import { NextRequest } from "next/server";

import { maskProviderKey, redactKey } from "../lib/ai/providers";
import type { FetchLike } from "../lib/ai/client";
import { decryptToken } from "../lib/meta/oauth";
import {
  deleteWorkspaceAiKey,
  getWorkspaceAiCredential,
  getWorkspaceAiKeyStatus,
  saveWorkspaceAiKey,
} from "../lib/ai/workspace-key";
import { DELETE, GET, POST } from "../app/api/workspace/ai-key/route";

const URL_BASE = "https://myreply.test/api/workspace/ai-key";
const WORKSPACE = "workspace_ours";

/**
 * Obviously fake, and shaped nothing like a real credential. Never put a
 * plausible provider key in a fixture: it reads as a leak in every future grep.
 */
const FAKE_KEY = "not-a-real-key-000000000000000000";

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );

  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: WORKSPACE,
    workspace: { id: WORKSPACE, name: "Ours" },
    role: "OWNER",
  });
  mockCanManage.mockImplementation((role: string) => ROLE_ORDER[role] >= 2);
  mockValidate.mockResolvedValue({ ok: true });

  mockPrisma.workspaceAiCredential.findUnique.mockResolvedValue(null);
  mockPrisma.workspaceAiCredential.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.workspaceAiCredential.updateMany.mockReturnValue({
    catch: () => undefined,
  });
  mockPrisma.workspaceAiCredential.upsert.mockImplementation(
    (args: { create: Record<string, unknown> }) => ({
      provider: args.create.provider,
      model: args.create.model,
      keyHint: args.create.keyHint,
      updatedAt: new Date("2026-09-04T00:00:00Z"),
      lastUsedAt: null,
    })
  );
});

describe("maskProviderKey", () => {
  it("keeps a head and a tail and drops the middle", () => {
    const masked = maskProviderKey(FAKE_KEY);
    expect(masked).toBe("not-a-r...0000");
    expect(masked).not.toBe(FAKE_KEY);
    expect(masked.length).toBeLessThan(FAKE_KEY.length);
  });

  it("gives away nothing at all for a short string", () => {
    expect(maskProviderKey("abc")).toBe("...");
  });
});

describe("redactKey", () => {
  it("removes the key from text that is about to be returned", () => {
    const text = `auth failed for ${FAKE_KEY} at 12:00`;
    const safe = redactKey(text, FAKE_KEY);
    expect(safe).not.toContain(FAKE_KEY);
    expect(safe).toContain("[redacted]");
  });
});

describe("validateProviderKey", () => {
  // The module is mocked above for the route tests, so reach past the mock for
  // the real implementation rather than testing the stub.
  let validateProviderKey: typeof import("../lib/ai/client").validateProviderKey;

  beforeAll(async () => {
    const actual =
      await vi.importActual<typeof import("../lib/ai/client")>(
        "../lib/ai/client"
      );
    validateProviderKey = actual.validateProviderKey;
  });

  function fakeFetch(
    status: number,
    body: unknown,
    seen?: { url?: string; headers?: Record<string, string> }
  ): FetchLike {
    return async (url, init) => {
      if (seen) {
        seen.url = url;
        seen.headers = init.headers as Record<string, string>;
      }
      return new Response(JSON.stringify(body), { status });
    };
  }

  it("accepts a key the provider authenticates", async () => {
    const result = await validateProviderKey(
      "ANTHROPIC",
      "claude-opus-5",
      FAKE_KEY,
      fakeFetch(200, { id: "claude-opus-5" })
    );
    expect(result.ok).toBe(true);
  });

  it("reports the provider's own wording when the key is rejected", async () => {
    const result = await validateProviderKey(
      "ANTHROPIC",
      "claude-opus-5",
      FAKE_KEY,
      fakeFetch(401, { error: { message: "invalid x-api-key" } })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid x-api-key");
  });

  it("separates a bad model from a bad key", async () => {
    const result = await validateProviderKey(
      "ANTHROPIC",
      "claude-nonexistent",
      FAKE_KEY,
      fakeFetch(404, { error: { message: "not_found" } })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("claude-nonexistent");
  });

  it("never lets the key back out through the provider's error text", async () => {
    const result = await validateProviderKey(
      "OPENROUTER",
      "anthropic/claude-opus-5",
      FAKE_KEY,
      fakeFetch(401, { error: { message: `bad token ${FAKE_KEY}` } })
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(FAKE_KEY);
  });

  it("rejects an obviously-too-short key without calling out", async () => {
    const calls: string[] = [];
    const result = await validateProviderKey("ANTHROPIC", "m", "short", async (
      url
    ) => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("workspace key storage", () => {
  it("stores ciphertext and a hint, never the key itself", async () => {
    await saveWorkspaceAiKey({
      workspaceId: WORKSPACE,
      provider: "ANTHROPIC",
      apiKey: FAKE_KEY,
      model: "claude-opus-5",
      createdByUserId: "user_1",
    });

    const args = mockPrisma.workspaceAiCredential.upsert.mock.calls[0][0];
    const written = JSON.stringify(args);
    expect(written).not.toContain(FAKE_KEY);
    expect(args.create.encryptedKey).not.toContain(FAKE_KEY);
    expect(decryptToken(args.create.encryptedKey)).toBe(FAKE_KEY);
    expect(args.create.keyHint).toBe(maskProviderKey(FAKE_KEY));
  });

  it("falls back to the provider default when no model is given", async () => {
    await saveWorkspaceAiKey({
      workspaceId: WORKSPACE,
      provider: "OPENROUTER",
      apiKey: FAKE_KEY,
    });
    const args = mockPrisma.workspaceAiCredential.upsert.mock.calls[0][0];
    expect(args.create.model).toBe("anthropic/claude-opus-5");
  });

  it("reports an unconfigured workspace rather than throwing", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "FREE" });

    const status = await getWorkspaceAiKeyStatus(WORKSPACE);
    expect(status.configured).toBe(false);
    expect(status.keyHint).toBeNull();
    expect(await getWorkspaceAiCredential(WORKSPACE)).toBeNull();
  });

  it("falls back to the managed key on PRO, and never on FREE", async () => {
    process.env.MANAGED_AI_API_KEY = "test-managed-key-not-real";
    mockPrisma.workspaceAiCredential.findUnique.mockResolvedValue(null);

    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "FREE" });
    expect(await getWorkspaceAiCredential(WORKSPACE)).toBeNull();

    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" });
    const managed = await getWorkspaceAiCredential(WORKSPACE);
    expect(managed?.apiKey).toBe("test-managed-key-not-real");

    delete process.env.MANAGED_AI_API_KEY;
  });

  it("prefers the workspace's own key over the managed one", async () => {
    // Someone who pasted a key expects that key to be the one billed. Quietly
    // spending ours instead would be both surprising and expensive.
    process.env.MANAGED_AI_API_KEY = "test-managed-key-not-real";
    const { encryptToken } = await import("../lib/meta/oauth");
    mockPrisma.workspaceAiCredential.findUnique.mockResolvedValue({
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      encryptedKey: encryptToken("their-own-key-not-real"),
    });
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" });

    const credential = await getWorkspaceAiCredential(WORKSPACE);
    expect(credential?.apiKey).toBe("their-own-key-not-real");
    expect(mockPrisma.workspace.findUnique).not.toHaveBeenCalled();

    delete process.env.MANAGED_AI_API_KEY;
  });

  it("round-trips the key for a model call and scopes the read by workspace", async () => {
    const { encryptToken } = await import("../lib/meta/oauth");
    mockPrisma.workspaceAiCredential.findUnique.mockResolvedValue({
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      encryptedKey: encryptToken(FAKE_KEY),
    });

    const credential = await getWorkspaceAiCredential(WORKSPACE);
    expect(credential?.apiKey).toBe(FAKE_KEY);
    expect(
      mockPrisma.workspaceAiCredential.findUnique.mock.calls[0][0].where
    ).toEqual({ workspaceId: WORKSPACE });
  });

  it("says when there was nothing to delete", async () => {
    mockPrisma.workspaceAiCredential.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteWorkspaceAiKey(WORKSPACE)).toBe(false);
  });
});

describe("GET /api/workspace/ai-key", () => {
  it("requires a session", async () => {
    mockContext.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns status and the provider list, never a key", async () => {
    mockPrisma.workspaceAiCredential.findUnique.mockResolvedValue({
      provider: "ANTHROPIC",
      model: "claude-opus-5",
      keyHint: "not-a-r...0000",
      updatedAt: new Date("2026-09-04T00:00:00Z"),
      lastUsedAt: null,
    });

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(FAKE_KEY);
    expect(body).not.toContain("encryptedKey");
    expect(body).not.toContain("apiKey");

    const parsed = JSON.parse(body);
    expect(parsed.data.configured).toBe(true);
    expect(parsed.data.keyHint).toBe("not-a-r...0000");
    expect(parsed.data.providers.length).toBeGreaterThanOrEqual(2);
  });

  it("lets a MEMBER read status but marks them unable to manage it", async () => {
    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: WORKSPACE,
      workspace: { id: WORKSPACE, name: "Ours" },
      role: "MEMBER",
    });

    const response = await GET();
    const parsed = await response.json();

    expect(response.status).toBe(200);
    expect(parsed.data.canManage).toBe(false);
  });
});

describe("POST /api/workspace/ai-key", () => {
  it("refuses a MEMBER", async () => {
    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: WORKSPACE,
      workspace: { id: WORKSPACE, name: "Ours" },
      role: "MEMBER",
    });

    const response = await post({ provider: "ANTHROPIC", apiKey: FAKE_KEY });
    expect(response.status).toBe(403);
    expect(mockPrisma.workspaceAiCredential.upsert).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mockContext.mockResolvedValue(null);
    const response = await post({ provider: "ANTHROPIC", apiKey: FAKE_KEY });
    expect(response.status).toBe(401);
  });

  it("rejects an unknown provider and a stub of a key", async () => {
    expect((await post({ provider: "OPENAI", apiKey: FAKE_KEY })).status).toBe(
      400
    );
    expect((await post({ provider: "ANTHROPIC", apiKey: "abc" })).status).toBe(
      400
    );
    expect(mockPrisma.workspaceAiCredential.upsert).not.toHaveBeenCalled();
  });

  it("does not store a key the provider will not authenticate", async () => {
    mockValidate.mockResolvedValue({ ok: false, error: "invalid x-api-key" });

    const response = await post({ provider: "ANTHROPIC", apiKey: FAKE_KEY });
    const parsed = await response.json();

    expect(response.status).toBe(400);
    expect(parsed.error).toBe("invalid x-api-key");
    expect(mockPrisma.workspaceAiCredential.upsert).not.toHaveBeenCalled();
  });

  it("saves a good key and never echoes it back", async () => {
    const response = await post({
      provider: "ANTHROPIC",
      apiKey: FAKE_KEY,
      model: "claude-opus-5",
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(FAKE_KEY);
    expect(JSON.parse(body).data.keyHint).toBe(maskProviderKey(FAKE_KEY));

    const args = mockPrisma.workspaceAiCredential.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: WORKSPACE });
  });

  it("validates against the model that will actually be stored", async () => {
    await post({ provider: "OPENROUTER", apiKey: FAKE_KEY });
    expect(mockValidate).toHaveBeenCalledWith(
      "OPENROUTER",
      "anthropic/claude-opus-5",
      FAKE_KEY
    );
  });
});

describe("DELETE /api/workspace/ai-key", () => {
  it("refuses a MEMBER", async () => {
    mockContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: WORKSPACE,
      workspace: { id: WORKSPACE, name: "Ours" },
      role: "MEMBER",
    });

    const response = await DELETE();
    expect(response.status).toBe(403);
    expect(mockPrisma.workspaceAiCredential.deleteMany).not.toHaveBeenCalled();
  });

  it("removes only this workspace's row", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(
      mockPrisma.workspaceAiCredential.deleteMany.mock.calls[0][0].where
    ).toEqual({ workspaceId: WORKSPACE });
  });

  it("404s when there was no key to remove", async () => {
    mockPrisma.workspaceAiCredential.deleteMany.mockResolvedValue({ count: 0 });
    expect((await DELETE()).status).toBe(404);
  });
});
