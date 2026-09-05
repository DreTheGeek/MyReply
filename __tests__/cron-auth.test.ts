import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { $queryRaw: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  isCronRequest,
  resetCronSecretCache,
  verifyCronRequest,
} from "../lib/security/cron-auth";

const originalEnv = process.env.CRON_SECRET;
const originalNextAuth = process.env.NEXTAUTH_SECRET;

function request(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("https://reply.example.com/api/cron/refresh-tokens", {
    headers,
  });
}

/** What a vault read returns. */
function vaultHolds(secret: string | null) {
  mockPrisma.$queryRaw.mockResolvedValue(
    secret === null ? [] : [{ decrypted_secret: secret }]
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCronSecretCache();
  delete process.env.CRON_SECRET;
  process.env.NEXTAUTH_SECRET = "a-completely-different-session-key";
  vaultHolds("vault-cron-value");
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalEnv;
  if (originalNextAuth === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = originalNextAuth;
  resetCronSecretCache();
});

describe("the secret comes from Supabase Vault", () => {
  // The whole point: pg_cron builds its Authorization header from this same
  // vault row, so reading it here means the two cannot disagree.
  it("accepts the value pg_cron would have sent", async () => {
    await expect(
      verifyCronRequest(request("Bearer vault-cron-value"))
    ).resolves.toEqual({ ok: true });
  });

  it("prefers the vault over an environment variable that disagrees", async () => {
    process.env.CRON_SECRET = "stale-vercel-copy";

    expect(await isCronRequest(request("Bearer vault-cron-value"))).toBe(true);
    expect(await isCronRequest(request("Bearer stale-vercel-copy"))).toBe(false);
  });

  // Self-hosters run this without Supabase, so the env var still works when
  // there is no vault row to read.
  it("falls back to the environment when the vault has nothing", async () => {
    vaultHolds(null);
    process.env.CRON_SECRET = "self-hosted-value";

    expect(await isCronRequest(request("Bearer self-hosted-value"))).toBe(true);
  });

  it("denies when neither has a value", async () => {
    vaultHolds(null);

    await expect(verifyCronRequest(request("Bearer anything"))).resolves.toEqual(
      { ok: false, reason: "unconfigured" }
    );
  });

  it("treats a blank vault value as no value", async () => {
    vaultHolds("   ");

    expect(await isCronRequest(request("Bearer    "))).toBe(false);
  });

  // A database that cannot be reached must not become an open door.
  it("denies rather than opens when the vault read throws", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection refused"));

    expect(await isCronRequest(request("Bearer vault-cron-value"))).toBe(false);
  });
});

describe("rejection cases", () => {
  it("rejects a wrong secret, a missing header, and a prefix", async () => {
    expect(await isCronRequest(request("Bearer wrong"))).toBe(false);
    expect(await isCronRequest(request())).toBe(false);
    expect(await isCronRequest(request("Bearer vault-cron"))).toBe(false);
    expect(await isCronRequest(request("Bearer vault-cron-value-extra"))).toBe(
      false
    );
  });

  // This authenticated when nothing was configured, before the null guard.
  it("never accepts the literal string Bearer undefined", async () => {
    vaultHolds(null);
    expect(await isCronRequest(request("Bearer undefined"))).toBe(false);
  });

  // The session signing key travels nowhere near this: it would end up in an
  // Authorization header on every tick and in the pg_net response tables.
  it("never accepts NEXTAUTH_SECRET", async () => {
    vaultHolds(null);
    expect(
      await isCronRequest(request(`Bearer ${process.env.NEXTAUTH_SECRET}`))
    ).toBe(false);
  });
});

describe("caching", () => {
  it("does not hit the database on every request", async () => {
    await isCronRequest(request("Bearer vault-cron-value"));
    await isCronRequest(request("Bearer vault-cron-value"));
    await isCronRequest(request("Bearer wrong"));

    // Otherwise an unauthenticated flood would be a free way to make us do
    // database work before we can say no.
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("reads again once the cache is cleared, so a rotation applies", async () => {
    await isCronRequest(request("Bearer vault-cron-value"));

    resetCronSecretCache();
    vaultHolds("rotated-value");

    expect(await isCronRequest(request("Bearer rotated-value"))).toBe(true);
    expect(await isCronRequest(request("Bearer vault-cron-value"))).toBe(false);
  });
});
