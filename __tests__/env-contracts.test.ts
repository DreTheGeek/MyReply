import { describe, expect, it } from "vitest";

import { workerEnvSchema, serverEnvSchema } from "../lib/env";

const KEY = "a".repeat(64);

/**
 * The worker crashed in production because it was held to the web app's
 * contract. These pin the difference so it cannot happen again.
 */
describe("the worker's environment contract", () => {
  const workerEnv = {
    DATABASE_URL: "postgres://localhost/db",
    REDIS_URL: "redis://localhost:6379",
    ENCRYPTION_KEY: KEY,
    NEXTAUTH_URL: "https://reply.example.com",
  };

  it("accepts exactly what the worker reads", () => {
    expect(workerEnvSchema.safeParse(workerEnv).success).toBe(true);
  });

  // The one that took production down.
  it("does not demand WEBHOOK_VERIFY_TOKEN, which the worker never uses", () => {
    expect(workerEnvSchema.safeParse(workerEnv).success).toBe(true);
    expect(serverEnvSchema.safeParse(workerEnv).success).toBe(false);
  });

  it("does not demand the app secrets or the session secret either", () => {
    for (const absent of [
      "NEXTAUTH_SECRET",
      "INSTAGRAM_APP_ID",
      "INSTAGRAM_APP_SECRET",
      "FACEBOOK_APP_SECRET",
    ]) {
      expect(Object.keys(workerEnvSchema.shape)).not.toContain(absent);
    }
  });

  // Missing, buildTrackedUrl falls back to http://localhost:3000 and the
  // worker sends real customers a link to a machine not on the internet.
  it("requires NEXTAUTH_URL, because a missing one sends localhost links", () => {
    const { NEXTAUTH_URL: _omitted, ...withoutUrl } = workerEnv;
    expect(workerEnvSchema.safeParse(withoutUrl).success).toBe(false);
    expect(
      workerEnvSchema.safeParse({ ...workerEnv, NEXTAUTH_URL: "not-a-url" })
        .success
    ).toBe(false);
  });

  it("refuses a malformed encryption key rather than failing at first decrypt", () => {
    expect(
      workerEnvSchema.safeParse({ ...workerEnv, ENCRYPTION_KEY: "too-short" })
        .success
    ).toBe(false);
  });
});
