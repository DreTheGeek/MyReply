import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import {
  extractApiKey,
  generateApiKey,
  hashApiKey,
  resolveApiKey,
} from "../lib/api-keys";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.apiKey.update.mockReturnValue({ catch: () => undefined });
});

describe("generateApiKey", () => {
  it("produces a prefixed key, a short display prefix, and a hash", () => {
    const key = generateApiKey();
    expect(key.plaintext.startsWith("mr_live_")).toBe(true);
    expect(key.prefix.startsWith("mr_live_")).toBe(true);
    expect(key.prefix.length).toBeLessThan(key.plaintext.length);
    expect(key.hashedKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never stores the plaintext in the hash, and the hash is reproducible", () => {
    const key = generateApiKey();
    expect(key.hashedKey).not.toContain(key.plaintext);
    expect(hashApiKey(key.plaintext)).toBe(key.hashedKey);
  });

  it("does not repeat itself", () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => generateApiKey().plaintext)
    );
    expect(seen.size).toBe(50);
  });
});

describe("extractApiKey", () => {
  it("pulls a bearer token that carries our prefix", () => {
    expect(extractApiKey("Bearer mr_live_abc123")).toBe("mr_live_abc123");
  });

  it("is case insensitive on the scheme and tolerates extra whitespace", () => {
    expect(extractApiKey("  bearer   mr_live_abc123  ")).toBe("mr_live_abc123");
  });

  it("ignores a bearer that is not one of ours, so session auth still runs", () => {
    expect(extractApiKey("Bearer some-other-token")).toBeNull();
  });

  it("ignores a missing or malformed header", () => {
    expect(extractApiKey(null)).toBeNull();
    expect(extractApiKey("")).toBeNull();
    expect(extractApiKey("mr_live_abc123")).toBeNull();
    expect(extractApiKey("Basic mr_live_abc123")).toBeNull();
  });
});

describe("resolveApiKey", () => {
  const active = {
    id: "key_1",
    workspaceId: "ws_1",
    role: "ADMIN",
    revokedAt: null,
    expiresAt: null,
  };

  it("looks the key up by hash, never by plaintext", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(active);
    await resolveApiKey("mr_live_secret");

    const where = mockPrisma.apiKey.findUnique.mock.calls[0][0].where;
    expect(where.hashedKey).toBe(hashApiKey("mr_live_secret"));
    expect(JSON.stringify(where)).not.toContain("mr_live_secret");
  });

  it("resolves an active key to its workspace and role", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(active);
    await expect(resolveApiKey("mr_live_secret")).resolves.toEqual({
      workspaceId: "ws_1",
      role: "ADMIN",
      apiKeyId: "key_1",
    });
  });

  it("rejects an unknown key", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null);
    await expect(resolveApiKey("mr_live_nope")).resolves.toBeNull();
  });

  it("rejects a revoked key", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      ...active,
      revokedAt: new Date("2020-01-01"),
    });
    await expect(resolveApiKey("mr_live_secret")).resolves.toBeNull();
  });

  it("rejects an expired key", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      ...active,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(resolveApiKey("mr_live_secret")).resolves.toBeNull();
  });

  it("accepts a key whose expiry is still in the future", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      ...active,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(resolveApiKey("mr_live_secret")).resolves.toMatchObject({
      workspaceId: "ws_1",
    });
  });

  it("carries a MEMBER key's lower role through rather than assuming ADMIN", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      ...active,
      role: "MEMBER",
    });
    await expect(resolveApiKey("mr_live_secret")).resolves.toMatchObject({
      role: "MEMBER",
    });
  });
});
