import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Hybrid retrieval tests.
 *
 * Nothing here touches a database or an embedding service. Prisma is mocked at
 * the module boundary and the embedder is injected, which is the point of both
 * being injectable: the paths that matter most are the ones where the embedder
 * is absent, broken or slow, and those have to be exercised deterministically.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    knowledgeChunk: { findMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  rankCandidates,
  retrieveForQuestion,
  VECTOR_CANDIDATE_LIMIT,
  type SemanticHit,
} from "@/lib/ai/retrieval";
import { EMBEDDING_DIMENSION } from "@/lib/ai/embeddings";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface Row {
  id: string;
  content: string;
  citation: string | null;
  source: { id: string; title: string };
}

function row(id: string, content: string, title = "Shipping policy"): Row {
  return {
    id,
    content,
    citation: null,
    source: { id: "src_1", title },
  };
}

/** The question a term index cannot answer and an embedding can. */
const QUESTION = "how long till it arrives";

/** Matches "long" twice and "till" once. Top of the BM25 ranking. */
const LEXICAL_ONLY = row(
  "chunk_lex",
  "How long till the sale ends? Not long, it closes on Friday."
);

/** Shares no query term at all. Only the vector stage can find this. */
const SEMANTIC_ONLY = row(
  "chunk_vec",
  "Orders leave the workshop the next working day and reach you in about a week."
);

/** Matches "long" once, and the vector stage likes it too. */
const BOTH = row("chunk_both", "Delivery takes as long as five days.");

const POOL = [LEXICAL_ONLY, SEMANTIC_ONLY, BOTH];

const SEMANTIC: SemanticHit[] = [
  { chunkId: "chunk_vec", distance: 0.11 },
  { chunkId: "chunk_both", distance: 0.22 },
];

/**
 * Only these keys are touched, and each is put back exactly as it was. Vitest
 * workers share one process.env, so replacing the whole object would leak into
 * whatever test file runs next in the same worker.
 */
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

function configureEmbedding(): void {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.EMBED_SHARED_SECRET = "test-secret";
}

function unconfigureEmbedding(): void {
  for (const key of TOUCHED_ENV) delete process.env[key];
}

function vector(): number[] {
  return new Array<number>(EMBEDDING_DIMENSION).fill(0.05);
}

beforeEach(() => {
  vi.clearAllMocks();
  unconfigureEmbedding();
  mockPrisma.knowledgeChunk.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockResolvedValue([1, 1, []]);
});

afterEach(() => {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* -------------------------------------------------------------------------- */
/* Fusion                                                                     */
/* -------------------------------------------------------------------------- */

describe("reciprocal rank fusion", () => {
  it("puts the chunk both stages found above the best hit of either alone", () => {
    const result = rankCandidates(QUESTION, POOL, SEMANTIC);

    // chunk_both is second in each list, which under RRF beats being first in
    // one of them. That is the whole reason to fuse ranks rather than scores:
    // agreement between two methods that fail differently is the strongest
    // evidence available.
    expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual([
      "chunk_both",
      "chunk_lex",
      "chunk_vec",
    ]);
  });

  it("retrieves a passage that shares no word with the question", () => {
    const result = rankCandidates(QUESTION, POOL, SEMANTIC);
    const semantic = result.chunks.find((chunk) => chunk.chunkId === "chunk_vec");

    expect(semantic).toBeDefined();
    expect(semantic?.matchedTerms).toEqual([]);
    expect(semantic?.score).toBe(0);
    expect(semantic?.lexicalRank).toBeNull();
    expect(semantic?.semanticRank).toBe(1);
    expect(semantic?.distance).toBe(0.11);
  });

  it("ranks by distance rather than by the order the rows arrived in", () => {
    const shuffled: SemanticHit[] = [
      { chunkId: "chunk_both", distance: 0.9 },
      { chunkId: "chunk_vec", distance: 0.1 },
    ];

    const result = rankCandidates(QUESTION, POOL, shuffled);
    const byId = new Map(result.chunks.map((chunk) => [chunk.chunkId, chunk]));

    expect(byId.get("chunk_vec")?.semanticRank).toBe(1);
    expect(byId.get("chunk_both")?.semanticRank).toBe(2);
  });

  it("ignores a vector hit for a chunk that is not in the pool", () => {
    const result = rankCandidates(QUESTION, [LEXICAL_ONLY], [
      { chunkId: "chunk_missing", distance: 0.01 },
    ]);

    expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(["chunk_lex"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Degrading to BM25                                                          */
/* -------------------------------------------------------------------------- */

describe("retrieval without any embeddings", () => {
  it("ranks exactly as it did before the vector stage existed", () => {
    const withVectors = rankCandidates(QUESTION, POOL, []);

    // Every embedding null is the state of every workspace ingested before this
    // column existed, and it has to be a complete answer path rather than a
    // degraded one.
    expect(withVectors.chunks.map((chunk) => chunk.chunkId)).toEqual([
      "chunk_lex",
      "chunk_both",
    ]);
    expect(withVectors.chunks[0].fusedScore).toBeGreaterThan(
      withVectors.chunks[1].fusedScore
    );
  });

  it("still drops a candidate that only matched as a substring", () => {
    // The substring guard is what the vector exception must not weaken: a row
    // the ILIKE net pulled in has no semantic rank, so it still scores nothing.
    const result = rankCandidates("car", [row("chunk_9", "We sell carpet.")], []);

    expect(result.chunks).toHaveLength(0);
    expect(result.coverage).toBe(0);
  });

  it("does not let a semantic-only chunk move coverage", () => {
    const lexicalOnly = rankCandidates(QUESTION, POOL, []);
    const hybrid = rankCandidates(QUESTION, POOL, SEMANTIC);

    // Same pool, so the same inverse document frequencies, and the extra chunk
    // carries none of the question's terms. Confidence therefore cannot be
    // inflated by a passage that merely looked similar in vector space.
    expect(hybrid.coverage).toBe(lexicalOnly.coverage);
  });
});

/* -------------------------------------------------------------------------- */
/* The query path                                                             */
/* -------------------------------------------------------------------------- */

describe("retrieveForQuestion", () => {
  it("never touches the vector stage when the embedder is not configured", async () => {
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([LEXICAL_ONLY]);
    const embed = vi.fn(async () => vector());

    const result = await retrieveForQuestion("ws_1", QUESTION, { embed });

    expect(embed).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(["chunk_lex"]);
  });

  it("answers from BM25 when the embedder throws", async () => {
    configureEmbedding();
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([LEXICAL_ONLY, BOTH]);
    const embed = vi.fn(async (): Promise<number[]> => {
      throw new Error("embedding service unreachable");
    });

    const result = await retrieveForQuestion("ws_1", QUESTION, { embed });

    expect(embed).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual([
      "chunk_lex",
      "chunk_both",
    ]);
  });

  it("answers from BM25 when the vector query itself fails", async () => {
    configureEmbedding();
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([LEXICAL_ONLY]);
    mockPrisma.$transaction.mockRejectedValue(new Error("relation does not exist"));

    const result = await retrieveForQuestion("ws_1", QUESTION, {
      embed: async () => vector(),
    });

    expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(["chunk_lex"]);
  });

  it("answers from BM25 when the embedder declines to answer", async () => {
    configureEmbedding();
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([LEXICAL_ONLY]);

    const result = await retrieveForQuestion("ws_1", QUESTION, {
      embed: async () => null,
    });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(result.chunks).toHaveLength(1);
  });

  it("adds neighbours the lexical query never saw to the pool", async () => {
    configureEmbedding();
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([LEXICAL_ONLY]);
    mockPrisma.$transaction.mockResolvedValue([
      1,
      1,
      [
        {
          id: SEMANTIC_ONLY.id,
          content: SEMANTIC_ONLY.content,
          citation: null,
          sourceId: "src_1",
          sourceTitle: "Shipping policy",
          distance: 0.12,
        },
      ],
    ]);

    const result = await retrieveForQuestion("ws_1", QUESTION, {
      embed: async () => vector(),
    });

    expect(result.chunks.map((chunk) => chunk.chunkId).sort()).toEqual([
      "chunk_lex",
      "chunk_vec",
    ]);
    expect(result.poolSize).toBe(2);
  });

  it("scopes the vector query to the workspace, to READY sources and to the app schema", async () => {
    configureEmbedding();
    process.env.DATABASE_SCHEMA = "openreply";
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([]);

    await retrieveForQuestion("ws_1", QUESTION, { embed: async () => vector() });

    const [sql, vectorLiteral, workspaceId] =
      mockPrisma.$queryRawUnsafe.mock.calls[0];

    expect(sql).toContain('"openreply"."KnowledgeChunk"');
    expect(sql).toContain('"openreply"."KnowledgeSource"');
    expect(sql).toContain('s."workspaceId" = $2');
    expect(sql).toContain(`s."status" = 'READY'`);
    expect(sql).toContain('c."embedding" IS NOT NULL');
    expect(sql).toContain(`LIMIT ${VECTOR_CANDIDATE_LIMIT}`);
    expect(workspaceId).toBe("ws_1");
    // pgvector's text input format, and no cast, because the extension's schema
    // is not necessarily on this connection's search path.
    expect(String(vectorLiteral).startsWith("[")).toBe(true);
    expect(sql).not.toContain("::vector");
  });

  it("asks for a full candidate list from the index rather than the default", async () => {
    configureEmbedding();
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([]);

    await retrieveForQuestion("ws_1", QUESTION, { embed: async () => vector() });

    const statements = mockPrisma.$executeRawUnsafe.mock.calls.map(
      (call: unknown[]) => String(call[0])
    );

    expect(statements[0]).toContain("hnsw.ef_search");
    // Without an iterative scan a filtered search on a shared table can return
    // nothing at all for a small tenant, which would look exactly like a
    // workspace with no knowledge.
    expect(statements[1]).toContain("hnsw.iterative_scan");
  });

  it("spends nothing at all on a question with no content terms", async () => {
    configureEmbedding();
    const embed = vi.fn(async () => vector());

    const result = await retrieveForQuestion("ws_1", "the and it", { embed });

    expect(embed).not.toHaveBeenCalled();
    expect(mockPrisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(result.chunks).toHaveLength(0);
  });
});
