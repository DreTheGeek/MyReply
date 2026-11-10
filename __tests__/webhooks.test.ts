/**
 * Outbound webhooks: signed the Standard Webhooks way, sent only to public
 * https hosts with no redirects, retried with backoff, logged, delivered once
 * per event per endpoint, and never to anyone else's endpoint.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockEnqueue } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn() },
    webhookEndpoint: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    webhookDelivery: { createMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockEnqueue: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/webhooks/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webhooks/queue")>()),
  enqueueWebhookDelivery: mockEnqueue,
}));

import { encryptToken } from "../lib/security/token-crypto";
import { attemptDelivery, WebhookDeliveryRetry } from "../lib/webhooks/deliver";
import {
  createEndpoint,
  createEndpointSchema,
  deleteEndpoint,
  listEndpoints,
  updateEndpoint,
} from "../lib/webhooks/endpoints";
import { deliveryIdFor, emitEvent, eventIdFor } from "../lib/webhooks/events";
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS, webhookRetryDelay } from "../lib/webhooks/queue";
import { postWebhook, type PostFetch } from "../lib/webhooks/send";
import { generateWebhookSecret, signWebhook, verifyWebhook, webhookHeaders } from "../lib/webhooks/signing";

const publicHost = async (): Promise<string[]> => ["93.184.216.34"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  mockEnqueue.mockResolvedValue(undefined);
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

describe("signing", () => {
  it("matches the Standard Webhooks reference vector", () => {
    // From the standard-webhooks specification's own test suite.
    expect(
      signWebhook(
        "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        "msg_p5jXN8AQM9LWM0D4loKWxJek",
        1614265330,
        '{"test": 2432232314}'
      )
    ).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("verifies its own signature and refuses an edited body or a stale timestamp", () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ id: "evt_1", type: "dm.received" });
    const headers = webhookHeaders(secret, "evt_1", 1_800_000_000, body);
    const parts = { id: "evt_1", timestamp: headers["webhook-timestamp"], signature: headers["webhook-signature"] };

    expect(verifyWebhook(secret, parts, body, 1_800_000_000)).toBe(true);
    expect(verifyWebhook(secret, parts, body.replace("dm", "xx"), 1_800_000_000)).toBe(false);
    expect(verifyWebhook(secret, parts, body, 1_800_000_000 + 301)).toBe(false);
    expect(verifyWebhook(generateWebhookSecret(), parts, body, 1_800_000_000)).toBe(false);
  });

  it("names nothing of ours in the headers", () => {
    const headers = webhookHeaders(generateWebhookSecret(), "evt_1", 1, "{}");
    expect(JSON.stringify(headers).toLowerCase()).not.toContain("myreply");
  });
});

describe("emitting an event", () => {
  it("delivers to the workspace's endpoints and its partner's, keyed so a repeat is one event", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws_1", partnerId: "partner_lash", externalId: "studio-1" });
    mockPrisma.webhookEndpoint.findMany.mockResolvedValue([{ id: "ep_ws" }, { id: "ep_partner" }]);

    await emitEvent({ workspaceId: "ws_1", type: "dm.received", dedupeKey: "acct_1:mid_1", data: { a: 1 } });

    const where = mockPrisma.webhookEndpoint.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      disabledAt: null,
      events: { has: "dm.received" },
      OR: [{ workspaceId: "ws_1" }, { partnerId: "partner_lash" }],
    });

    const { data, skipDuplicates } = mockPrisma.webhookDelivery.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    const eventId = eventIdFor({ workspaceId: "ws_1", type: "dm.received", dedupeKey: "acct_1:mid_1" });
    expect(data.map((row: { id: string }) => row.id)).toEqual([
      deliveryIdFor(eventId, "ep_ws"),
      deliveryIdFor(eventId, "ep_partner"),
    ]);
    const body = JSON.parse(data[0].payload);
    expect(body).toMatchObject({
      id: eventId,
      type: "dm.received",
      workspace: { id: "ws_1", externalId: "studio-1" },
      data: { a: 1 },
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });

  it("asks only for the workspace's own endpoints when it has no partner", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws_2", partnerId: null, externalId: null });
    mockPrisma.webhookEndpoint.findMany.mockResolvedValue([]);
    await emitEvent({ workspaceId: "ws_2", type: "dm.sent", data: {} });
    expect(mockPrisma.webhookEndpoint.findMany.mock.calls[0][0].where.OR).toEqual([{ workspaceId: "ws_2" }]);
    expect(mockPrisma.webhookDelivery.createMany).not.toHaveBeenCalled();
  });

  it("derives the same event id from the same happening, and a new one without a key", () => {
    const key = { workspaceId: "ws_1", type: "comment.received" as const, dedupeKey: "c1" };
    expect(eventIdFor(key)).toBe(eventIdFor(key));
    expect(eventIdFor({ ...key, workspaceId: "ws_2" })).not.toBe(eventIdFor(key));
    expect(eventIdFor({ workspaceId: "ws_1", type: "dm.failed" })).not.toBe(
      eventIdFor({ workspaceId: "ws_1", type: "dm.failed" })
    );
  });

  it("never throws into the code that raised it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.workspace.findUnique.mockRejectedValue(new Error("down"));
    await expect(emitEvent({ workspaceId: "ws_1", type: "dm.sent", data: {} })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("sending", () => {
  const ok: PostFetch = async () => new Response("ok", { status: 200 });

  it("refuses http, credentials and internal names before sending anything", async () => {
    const fetchImpl = vi.fn(ok);
    for (const url of ["http://hooks.example.com/x", "https://u:p@hooks.example.com", "https://localhost/x", "https://db.internal/x"]) {
      const result = await postWebhook(url, {}, "{}", { fetchImpl, resolve: publicHost });
      expect(result.ok, url).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to a private or metadata address", async () => {
    const fetchImpl = vi.fn(ok);
    for (const address of ["10.0.0.5", "169.254.169.254", "127.0.0.1", "192.168.1.1", "::1"]) {
      const result = await postWebhook("https://hooks.example.com/x", {}, "{}", {
        fetchImpl,
        resolve: async () => [address],
      });
      expect(result, address).toMatchObject({ ok: false, reason: "address is private or reserved" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not follow a redirect", async () => {
    const result = await postWebhook("https://hooks.example.com/x", {}, "{}", {
      resolve: publicHost,
      fetchImpl: async (_url, init) => {
        expect(init.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
      },
    });
    expect(result).toMatchObject({ ok: false, status: 302 });
  });

  it("counts any 2xx as delivered and anything else as not", async () => {
    expect(await postWebhook("https://hooks.example.com/x", {}, "{}", { resolve: publicHost, fetchImpl: async () => new Response(null, { status: 204 }) })).toEqual({ ok: true, status: 204 });
    expect(await postWebhook("https://hooks.example.com/x", {}, "{}", { resolve: publicHost, fetchImpl: async () => new Response(null, { status: 500 }) })).toMatchObject({ ok: false, reason: "HTTP 500" });
  });

  it("gives up after its deadline", async () => {
    const result = await postWebhook("https://hooks.example.com/x", {}, "{}", {
      resolve: publicHost,
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect(result).toMatchObject({ ok: false, reason: "timed out after 10 seconds" });
  });
});

describe("a delivery attempt", () => {
  const secret = generateWebhookSecret();
  function delivery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "whd_1",
      eventId: "evt_1",
      payload: '{"id":"evt_1"}',
      status: "PENDING",
      endpoint: { id: "ep_1", url: "https://hooks.example.com/x", secretEncrypted: encryptToken(secret), disabledAt: null },
      ...overrides,
    };
  }

  it("signs the exact body with a fresh timestamp and records the success", async () => {
    mockPrisma.webhookDelivery.findUnique.mockResolvedValue(delivery());
    let seen: Record<string, string> = {};
    const outcome = await attemptDelivery("whd_1", 1, {
      resolve: publicHost,
      now: () => new Date(1_800_000_000_000),
      fetchImpl: async (_url, init) => {
        seen = init.headers;
        expect(init.body).toBe('{"id":"evt_1"}');
        return new Response(null, { status: 200 });
      },
    });
    expect(outcome).toBe("delivered");
    expect(seen["webhook-id"]).toBe("evt_1");
    expect(
      verifyWebhook(secret, { id: "evt_1", timestamp: seen["webhook-timestamp"], signature: seen["webhook-signature"] }, '{"id":"evt_1"}', 1_800_000_000)
    ).toBe(true);
    expect(mockPrisma.webhookDelivery.update.mock.calls[0][0].data).toMatchObject({ status: "DELIVERED", attempts: 1, lastStatusCode: 200 });
    expect(mockPrisma.webhookEndpoint.update.mock.calls[0][0].data).toEqual({ consecutiveFailures: 0 });
  });

  it("throws to be retried, with the reason logged and no body kept", async () => {
    mockPrisma.webhookDelivery.findUnique.mockResolvedValue(delivery());
    await expect(
      attemptDelivery("whd_1", 2, { resolve: publicHost, fetchImpl: async () => new Response("stack trace here", { status: 500 }) })
    ).rejects.toBeInstanceOf(WebhookDeliveryRetry);
    const data = mockPrisma.webhookDelivery.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "PENDING", attempts: 2, lastStatusCode: 500, lastError: "HTTP 500" });
    expect(JSON.stringify(data)).not.toContain("stack trace");
  });

  it("marks the last attempt failed and counts it against the endpoint", async () => {
    mockPrisma.webhookDelivery.findUnique.mockResolvedValue(delivery());
    const outcome = await attemptDelivery("whd_1", WEBHOOK_MAX_ATTEMPTS, {
      resolve: publicHost,
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    expect(outcome).toBe("failed");
    expect(mockPrisma.webhookDelivery.update.mock.calls[0][0].data.status).toBe("FAILED");
    expect(mockPrisma.webhookEndpoint.update.mock.calls[0][0].data).toEqual({ consecutiveFailures: { increment: 1 } });
  });

  it("skips what was already delivered, or whose endpoint was switched off", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    mockPrisma.webhookDelivery.findUnique.mockResolvedValueOnce(delivery({ status: "DELIVERED" }));
    expect(await attemptDelivery("whd_1", 1, { fetchImpl, resolve: publicHost })).toBe("skipped");
    mockPrisma.webhookDelivery.findUnique.mockResolvedValueOnce(
      delivery({ endpoint: { id: "ep_1", url: "https://x.example", secretEncrypted: "", disabledAt: new Date() } })
    );
    expect(await attemptDelivery("whd_1", 1, { fetchImpl, resolve: publicHost })).toBe("skipped");
    mockPrisma.webhookDelivery.findUnique.mockResolvedValueOnce(null);
    expect(await attemptDelivery("whd_1", 1, { fetchImpl, resolve: publicHost })).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("retries", () => {
  it("back off from a minute to a day, over about two days", () => {
    const delays = [...WEBHOOK_RETRY_DELAYS_MS];
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(webhookRetryDelay(1)).toBe(60_000);
    expect(webhookRetryDelay(99)).toBe(24 * 3_600_000);
    const total = delays.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThan(36 * 3_600_000);
    expect(total).toBeLessThan(72 * 3_600_000);
  });
});

describe("endpoints belong to their owner", () => {
  interface Row {
    id: string;
    workspaceId: string | null;
    partnerId: string | null;
    url: string;
    events: string[];
    description: string | null;
    secretEncrypted: string;
    secretHint: string;
    consecutiveFailures: number;
    disabledAt: Date | null;
    createdAt: Date;
  }
  let rows: Row[] = [];
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([field, value]) => (row as unknown as Record<string, unknown>)[field] === value);

  beforeEach(() => {
    rows = [];
    mockPrisma.webhookEndpoint.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).length);
    mockPrisma.webhookEndpoint.create.mockImplementation(async ({ data }: { data: Partial<Row> }) => {
      const row: Row = { id: `ep_${rows.length}`, workspaceId: null, partnerId: null, url: "", events: [], description: null, secretEncrypted: "", secretHint: "", consecutiveFailures: 0, disabledAt: null, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    });
    mockPrisma.webhookEndpoint.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)));
    mockPrisma.webhookEndpoint.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null);
    mockPrisma.webhookEndpoint.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    });
    mockPrisma.webhookEndpoint.deleteMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      rows = rows.filter((row) => !matches(row, where));
      return { count: before - rows.length };
    });
  });

  it("hands the secret back once, stores it encrypted, and never lists it", async () => {
    const created = await createEndpoint({ workspaceId: "ws_1" }, { url: "https://hooks.example.com/a", events: ["dm.received"] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.secret.startsWith("whsec_")).toBe(true);
    expect(rows[0].secretEncrypted).not.toContain(created.secret);
    const listed = JSON.stringify(await listEndpoints({ workspaceId: "ws_1" }));
    expect(listed).not.toContain(created.secret);
    expect(listed).not.toContain(rows[0].secretEncrypted);
  });

  it("keeps one workspace's endpoints away from another, and from a partner", async () => {
    const created = await createEndpoint({ workspaceId: "ws_1" }, { url: "https://hooks.example.com/a", events: ["dm.sent"] });
    if (!created.ok) throw new Error("create failed");
    const id = created.endpoint.id;

    expect(await listEndpoints({ workspaceId: "ws_2" })).toEqual([]);
    expect(await listEndpoints({ partnerId: "partner_x" })).toEqual([]);
    expect(await updateEndpoint({ workspaceId: "ws_2" }, id, { url: "https://evil.example/x" })).toBeNull();
    expect(await deleteEndpoint({ partnerId: "partner_x" }, id)).toBe(false);
    expect(rows[0].url).toBe("https://hooks.example.com/a");
  });

  it("refuses an http URL and an unknown event", () => {
    expect(createEndpointSchema.safeParse({ url: "http://hooks.example.com", events: ["dm.sent"] }).success).toBe(false);
    expect(createEndpointSchema.safeParse({ url: "https://hooks.example.com", events: ["everything"] }).success).toBe(false);
    expect(createEndpointSchema.safeParse({ url: "https://hooks.example.com", events: [] }).success).toBe(false);
  });

  it("caps how many endpoints one owner keeps", async () => {
    for (let index = 0; index < 10; index += 1) {
      await createEndpoint({ partnerId: "partner_lash" }, { url: `https://hooks.example.com/${index}`, events: ["dm.sent"] });
    }
    const extra = await createEndpoint({ partnerId: "partner_lash" }, { url: "https://hooks.example.com/x", events: ["dm.sent"] });
    expect(extra.ok).toBe(false);
  });
});
