/**
 * Idempotency-Key on v1 writes: a retry is answered from the first attempt,
 * never run twice. The record table is in memory and enforces the same
 * unique key the database does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  credentialId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  status: number | null;
  body: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    idempotencyRecord: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { NextRequest } from "next/server";
import { Prisma } from "../app/generated/prisma/client";
import { withIdempotency } from "../lib/api/idempotency";

let rows: Row[] = [];

function write(body: unknown, key?: string, method = "POST"): NextRequest {
  return new NextRequest("https://myreply.test/api/v1/campaigns", {
    method,
    headers: {
      "content-type": "application/json",
      ...(key !== undefined ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  mockPrisma.idempotencyRecord.create.mockImplementation(async ({ data }: { data: Omit<Row, "id" | "status" | "body" | "createdAt" | "completedAt"> }) => {
    if (rows.some((row) => row.credentialId === data.credentialId && row.key === data.key)) {
      throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
    }
    const row: Row = { id: `r${rows.length}`, status: null, body: null, createdAt: new Date(), completedAt: null, ...data };
    rows.push(row);
    return { id: row.id };
  });
  mockPrisma.idempotencyRecord.findUnique.mockImplementation(
    async ({ where }: { where: { credentialId_key: { credentialId: string; key: string } } }) =>
      rows.find(
        (row) =>
          row.credentialId === where.credentialId_key.credentialId && row.key === where.credentialId_key.key
      ) ?? null
  );
  mockPrisma.idempotencyRecord.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    }
  );
  mockPrisma.idempotencyRecord.updateMany.mockImplementation(
    async ({ where, data }: { where: { id: string; status: null }; data: Partial<Row> }) => {
      const row = rows.find((candidate) => candidate.id === where.id && candidate.status === null);
      if (row) Object.assign(row, data);
      return { count: row ? 1 : 0 };
    }
  );
  mockPrisma.idempotencyRecord.delete.mockImplementation(async ({ where }: { where: { id: string } }) => {
    rows = rows.filter((row) => row.id !== where.id);
    return {};
  });
});

describe("Idempotency-Key", () => {
  it("runs a write once and replays the first answer to a retry", async () => {
    const handler = vi.fn(async (request: NextRequest) =>
      Response.json({ success: true, data: { id: "camp_1", got: await request.json() } }, { status: 201 })
    );

    const first = await withIdempotency(write({ name: "A" }, "k1"), "key:1", handler);
    const again = await withIdempotency(write({ name: "A" }, "k1"), "key:1", handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
  });

  it("hands the handler the body it was sent", async () => {
    const handler = vi.fn(async (request: NextRequest) => Response.json(await request.json()));
    const response = await withIdempotency(write({ name: "Body" }, "k-body"), "key:1", handler);
    expect(await response.json()).toEqual({ name: "Body" });
  });

  it("refuses the same key on a different request", async () => {
    const handler = vi.fn(async () => Response.json({ success: true }));
    await withIdempotency(write({ name: "A" }, "k2"), "key:1", handler);
    const other = await withIdempotency(write({ name: "B" }, "k2"), "key:1", handler);
    expect(other.status).toBe(422);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps two credentials' keys apart", async () => {
    const handler = vi.fn(async () => Response.json({ success: true }));
    await withIdempotency(write({ name: "A" }, "shared"), "key:1", handler);
    await withIdempotency(write({ name: "A" }, "shared"), "key:2", handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("tells a retry to wait while the first request is still running", async () => {
    rows.push({
      id: "busy",
      credentialId: "key:1",
      key: "k3",
      method: "POST",
      path: "/api/v1/campaigns",
      requestHash: "will-be-compared",
      status: null,
      body: null,
      createdAt: new Date(),
      completedAt: null,
    });
    // Same request as the stored one, so only "still running" can explain a refusal.
    const { createHash } = await import("crypto");
    rows[0].requestHash = createHash("sha256")
      .update(`POST\n/api/v1/campaigns\n${JSON.stringify({ name: "A" })}`)
      .digest("hex");

    const handler = vi.fn(async () => Response.json({ success: true }));
    const response = await withIdempotency(write({ name: "A" }, "k3"), "key:1", handler);
    expect(response.status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets a retry run again after the first attempt failed on our side", async () => {
    const handler = vi
      .fn<(request: NextRequest) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ success: true }, { status: 201 }));

    expect((await withIdempotency(write({ name: "A" }, "k4"), "key:1", handler)).status).toBe(503);
    expect((await withIdempotency(write({ name: "A" }, "k4"), "key:1", handler)).status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("releases the key when the handler throws", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withIdempotency(write({}, "k5"), "key:1", handler)).rejects.toThrow("boom");
    expect(rows).toHaveLength(0);
  });

  it("replays a refusal too, since the request did finish", async () => {
    const handler = vi.fn(async () => Response.json({ success: false, error: "bad" }, { status: 400 }));
    await withIdempotency(write({}, "k6"), "key:1", handler);
    const again = await withIdempotency(write({}, "k6"), "key:1", handler);
    expect(again.status).toBe(400);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed key and, where required, a missing one", async () => {
    const handler = vi.fn(async () => Response.json({ success: true }));
    expect((await withIdempotency(write({}, "has space"), "key:1", handler)).status).toBe(400);
    expect((await withIdempotency(write({}, "x".repeat(256)), "key:1", handler)).status).toBe(400);
    expect((await withIdempotency(write({}), "key:1", handler, { required: true })).status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves a write without a key, and every read, exactly as before", async () => {
    const handler = vi.fn(async () => Response.json({ success: true }));
    await withIdempotency(write({}), "key:1", handler);
    await withIdempotency(new NextRequest("https://myreply.test/api/v1/campaigns"), "key:1", handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
  });
});
