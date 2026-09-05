import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isCronRequest, verifyCronRequest } from "../lib/security/cron-auth";

const original = process.env.CRON_SECRET;
const originalNextAuth = process.env.NEXTAUTH_SECRET;

function request(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("https://reply.example.com/api/cron/refresh-tokens", {
    headers,
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret-cron-value";
  process.env.NEXTAUTH_SECRET = "a-completely-different-session-key";
});

afterEach(() => {
  if (original === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = original;
  if (originalNextAuth === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = originalNextAuth;
});

describe("verifyCronRequest", () => {
  it("accepts the configured secret", () => {
    expect(verifyCronRequest(request("Bearer s3cret-cron-value"))).toEqual({
      ok: true,
    });
  });

  it("rejects a wrong secret", () => {
    expect(isCronRequest(request("Bearer wrong"))).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isCronRequest(request())).toBe(false);
  });

  // The three routes that lacked a null guard compared against the string
  // "Bearer undefined", so that literal value authenticated when nothing was
  // configured. Missing configuration must deny.
  it("denies everything when no secret is configured", () => {
    delete process.env.CRON_SECRET;

    expect(verifyCronRequest(request("Bearer undefined"))).toEqual({
      ok: false,
      reason: "unconfigured",
    });
    expect(isCronRequest(request("Bearer anything"))).toBe(false);
    expect(isCronRequest(request())).toBe(false);
  });

  it("denies when the secret is configured but blank", () => {
    process.env.CRON_SECRET = "   ";
    expect(isCronRequest(request("Bearer    "))).toBe(false);
  });

  // The session signing key must never be usable as the cron bearer, because
  // this value is put on the wire on every tick and recorded in the pg_net
  // response tables.
  it("never accepts NEXTAUTH_SECRET as a fallback", () => {
    delete process.env.CRON_SECRET;
    expect(
      isCronRequest(request(`Bearer ${process.env.NEXTAUTH_SECRET}`))
    ).toBe(false);
  });

  it("rejects a prefix of the real secret rather than matching loosely", () => {
    expect(isCronRequest(request("Bearer s3cret"))).toBe(false);
    expect(isCronRequest(request("Bearer s3cret-cron-value-extra"))).toBe(false);
  });
});
