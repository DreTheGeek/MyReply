import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Embedding client tests.
 *
 * Every call to the Edge Function is a stubbed fetch. The point of most of
 * these is not the happy path: it is that a wrong sized vector is refused
 * loudly on the write path and degraded quietly on the read path, because those
 * are the two ways a swapped model would otherwise corrupt retrieval silently.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  appSchema,
  EMBEDDING_BATCH_LIMIT,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  EmbeddingError,
  embedQuery,
  embedTexts,
  isEmbeddingConfigured,
  qualified,
  toVectorLiteral,
  type FetchLike,
} from "@/lib/ai/embeddings";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const TOUCHED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_FUNCTIONS_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "EMBED_SHARED_SECRET",
  "DATABASE_SCHEMA",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(
  TOUCHED_ENV.map((key) => [key, process.env[key]])
);

function vectorOf(length: number): number[] {
  return new Array<number>(length).fill(0.1);
}

interface StubEntry {
  embedding: number[];
  truncated?: boolean;
  windows?: number;
}

function stubResponse(
  entries: StubEntry[],
  overrides: { dimensions?: number; status?: number } = {}
): Response {
  const body = {
    model: EMBEDDING_MODEL,
    dimensions: overrides.dimensions ?? EMBEDDING_DIMENSION,
    embeddings: entries.map((entry) => ({
      embedding: entry.embedding,
      truncated: entry.truncated ?? false,
      windows: entry.windows ?? 1,
    })),
  };

  return new Response(JSON.stringify(body), {
    status: overrides.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(response: () => Response): FetchLike {
  return vi.fn(async () => response()) as unknown as FetchLike;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of TOUCHED_ENV) delete process.env[key];
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.EMBED_SHARED_SECRET = "test-secret";
});

afterEach(() => {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* -------------------------------------------------------------------------- */
/* The dimension tripwire                                                     */
/* -------------------------------------------------------------------------- */

describe("the gte-small dimension", () => {
  it("is the width measured from the model itself", () => {
    // Measured rather than assumed: a forward pass through the published
    // Supabase/gte-small ONNX export, the artifact the edge runtime loads,
    // returns dims [1, 384]. The migration sizes the column to this number and
    // the Edge Function asserts it too, so all three move together or none do.
    expect(EMBEDDING_DIMENSION).toBe(384);
  });

  it("refuses a vector of the wrong width rather than storing it", async () => {
    const fetchImpl = stubFetch(() =>
      stubResponse([{ embedding: vectorOf(768) }])
    );

    await expect(embedTexts(["hello"], { fetchImpl })).rejects.toBeInstanceOf(
      EmbeddingError
    );
  });

  it("refuses a service that reports a different model width", async () => {
    const fetchImpl = stubFetch(() =>
      stubResponse([{ embedding: vectorOf(EMBEDDING_DIMENSION) }], {
        dimensions: 768,
      })
    );

    await expect(embedTexts(["hello"], { fetchImpl })).rejects.toThrow(
      /768 dimensions/
    );
  });

  it("refuses to build a literal from a wrong sized vector", () => {
    expect(() => toVectorLiteral(vectorOf(383))).toThrow(EmbeddingError);
    expect(toVectorLiteral([1, 2].concat(vectorOf(EMBEDDING_DIMENSION - 2)))).toContain(
      "["
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Calling the Edge Function                                                  */
/* -------------------------------------------------------------------------- */

describe("embedTexts", () => {
  it("authenticates with both the project key and the function's own secret", async () => {
    const fetchImpl = stubFetch(() =>
      stubResponse([{ embedding: vectorOf(EMBEDDING_DIMENSION) }])
    );

    await embedTexts(["hello"], { fetchImpl });

    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(url).toBe("https://project.supabase.co/functions/v1/embed");
    expect(init.method).toBe("POST");
    // The platform gate accepts the anon key, which is public, so the shared
    // secret is what actually closes the endpoint.
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["x-embed-secret"]).toBe("test-secret");
  });

  it("splits a long list into batches the function will accept", async () => {
    const fetchImpl = stubFetch(() =>
      stubResponse(
        new Array<StubEntry>(EMBEDDING_BATCH_LIMIT).fill({
          embedding: vectorOf(EMBEDDING_DIMENSION),
        })
      )
    );

    const texts = new Array<string>(EMBEDDING_BATCH_LIMIT).fill("hello");
    await embedTexts(texts, { fetchImpl });

    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
    ).toHaveLength(1);
  });

  it("reports which inputs the model had to truncate", async () => {
    const fetchImpl = stubFetch(() =>
      stubResponse([{ embedding: vectorOf(EMBEDDING_DIMENSION), truncated: true }])
    );

    const [embedding] = await embedTexts(["a very long passage"], { fetchImpl });

    expect(embedding.truncated).toBe(true);
  });

  it("throws when the service is unreachable rather than returning nothing", async () => {
    const fetchImpl = stubFetch(() =>
      stubResponse([], { status: 503 })
    );

    await expect(embedTexts(["hello"], { fetchImpl })).rejects.toBeInstanceOf(
      EmbeddingError
    );
  });

  it("throws when the service is not configured at all", async () => {
    delete process.env.EMBED_SHARED_SECRET;

    await expect(embedTexts(["hello"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it("does nothing, and calls nothing, for an empty list", async () => {
    const fetchImpl = stubFetch(() => stubResponse([]));

    expect(await embedTexts([], { fetchImpl })).toEqual([]);
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
    ).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The read path degrades                                                     */
/* -------------------------------------------------------------------------- */

describe("embedQuery", () => {
  it("returns a vector when everything is working", async () => {
    const fetchImpl = stubFetch(() =>
      stubResponse([{ embedding: vectorOf(EMBEDDING_DIMENSION) }])
    );

    const vector = await embedQuery("how long till it arrives", { fetchImpl });

    expect(vector).toHaveLength(EMBEDDING_DIMENSION);
  });

  it("returns null rather than throwing when the service is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchLike;

    // A customer is waiting on this call. The correct answer to a broken
    // embedder is BM25, not an exception on the answering path.
    expect(await embedQuery("hello", { fetchImpl })).toBeNull();
  });

  it("returns null rather than throwing when the model width changed", async () => {
    const fetchImpl = stubFetch(() =>
      stubResponse([{ embedding: vectorOf(1536) }])
    );

    expect(await embedQuery("hello", { fetchImpl })).toBeNull();
  });

  it("returns null without a request when nothing is configured", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fetchImpl = stubFetch(() => stubResponse([]));

    expect(await embedQuery("hello", { fetchImpl })).toBeNull();
    expect(isEmbeddingConfigured()).toBe(false);
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
    ).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* SQL plumbing                                                               */
/* -------------------------------------------------------------------------- */

describe("schema qualification", () => {
  it("defaults to public and follows DATABASE_SCHEMA when it is set", () => {
    expect(appSchema()).toBe("public");
    process.env.DATABASE_SCHEMA = "openreply";
    expect(qualified("KnowledgeChunk")).toBe('"openreply"."KnowledgeChunk"');
  });

  it("refuses a schema name that is not an identifier", () => {
    process.env.DATABASE_SCHEMA = 'public"; DROP TABLE "KnowledgeChunk';
    expect(() => qualified("KnowledgeChunk")).toThrow(/identifier/);
  });
});
