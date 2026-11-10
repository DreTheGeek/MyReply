/**
 * The per-credential limit on the two machine surfaces, /api/v1 and /api/mcp.
 *
 * What matters: a credential past its allowance is refused with a usable
 * Retry-After, a Redis outage refuses rather than waving everything through,
 * and one call is counted once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEval, mockStatus } = vi.hoisted(() => ({
  mockEval: vi.fn(),
  mockStatus: { value: "ready" },
}));

vi.mock("ioredis", () => ({
  default: class {
    get status(): string {
      return mockStatus.value;
    }
    eval = mockEval;
    listenerCount(): number {
      return 1;
    }
    on(): void {}
    async connect(): Promise<void> {
      mockStatus.value = "ready";
    }
  },
}));

import {
  REQUESTS_PER_WINDOW,
  consumeCredentialRequest,
  rateLimitRefusal,
} from "../lib/api/rate-limit";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  mockStatus.value = "ready";
});

describe("consumeCredentialRequest", () => {
  it("allows a request under the limit and says how many are left", async () => {
    mockEval.mockResolvedValue([1, 60]);
    await expect(consumeCredentialRequest("key:k1")).resolves.toEqual({
      status: "allowed",
      remaining: REQUESTS_PER_WINDOW - 1,
    });
  });

  it("keys the window by credential and never by the secret", async () => {
    mockEval.mockResolvedValue([1, 60]);
    await consumeCredentialRequest("key:k1");
    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "api-rate:key:k1",
      "60"
    );
  });

  it("refuses the request past the limit, with the time left in the window", async () => {
    mockEval.mockResolvedValue([REQUESTS_PER_WINDOW + 1, 17]);
    await expect(consumeCredentialRequest("key:k1")).resolves.toEqual({
      status: "limited",
      retryAfterSeconds: 17,
    });
  });

  it("allows exactly the limit and refuses the one after it", async () => {
    mockEval.mockResolvedValueOnce([REQUESTS_PER_WINDOW, 5]);
    expect((await consumeCredentialRequest("key:k1")).status).toBe("allowed");
    mockEval.mockResolvedValueOnce([REQUESTS_PER_WINDOW + 1, 5]);
    expect((await consumeCredentialRequest("key:k1")).status).toBe("limited");
  });

  it("fails closed when Redis errors", async () => {
    mockEval.mockRejectedValue(new Error("connection refused"));
    await expect(consumeCredentialRequest("key:k1")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails closed when Redis is not configured at all", async () => {
    vi.stubEnv("REDIS_URL", "");
    await expect(consumeCredentialRequest("key:k1")).resolves.toEqual({
      status: "unavailable",
    });
  });
});

describe("rateLimitRefusal", () => {
  it("answers 429 with Retry-After for a limited credential", () => {
    const refusal = rateLimitRefusal({ status: "limited", retryAfterSeconds: 9 });
    expect(refusal.status).toBe(429);
    expect(refusal.headers["Retry-After"]).toBe("9");
  });

  it("answers 503 for an unavailable limiter", () => {
    expect(rateLimitRefusal({ status: "unavailable" }).status).toBe(503);
  });
});
