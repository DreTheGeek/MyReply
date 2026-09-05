/**
 * The application's side of the embedding service.
 *
 * The model runs in a Supabase Edge Function (supabase/functions/embed), inside
 * the edge runtime, with no external API and no per-call charge. This file
 * calls it, validates what comes back, and writes vectors into
 * KnowledgeChunk.embedding.
 *
 * Two rules shape everything here.
 *
 * READS DEGRADE, WRITES FAIL LOUDLY. `embedQuery` is on the path where a real
 * customer is waiting, so every failure it can have becomes null and retrieval
 * carries on with BM25 alone. `embedTexts` is what the backfill and ingest use,
 * and it throws, because a write that silently stores a wrong sized or partial
 * vector poisons the index for every later question.
 *
 * THE DIMENSION IS ASSERTED, NOT ASSUMED. EMBEDDING_DIMENSION is checked
 * against the response on every call and against the column width in the
 * migration. Swapping the model behind the Edge Function therefore breaks
 * immediately and visibly, instead of writing 768 numbers into a vector(384)
 * column or, worse, writing vectors from a different model into the same space
 * as the old ones and quietly ruining the rankings.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { appSchema, qualified } from "@/lib/db/schema";

/** The model the Edge Function loads. Must match MODEL in that function. */
export const EMBEDDING_MODEL = "gte-small";

/**
 * Output width of gte-small.
 *
 * Measured, not assumed: a forward pass through the published
 * Supabase/gte-small ONNX export, the same artifact the edge runtime loads,
 * returns dims [1, 384] with an L2 norm of 1.000000 under
 * { mean_pool: true, normalize: true }. The model config agrees
 * (hidden_size 384, max_position_embeddings 512).
 *
 * This constant is the tripwire. It appears in the vector column's width, in
 * the Edge Function, and in every response check below.
 */
export const EMBEDDING_DIMENSION = 384;

/** Inputs per request to the Edge Function. Must not exceed its MAX_INPUTS. */
export const EMBEDDING_BATCH_LIMIT = 32;

/**
 * How long a query embedding may take before retrieval gives up on it.
 *
 * lib/ai/answering.ts has 20 seconds for the whole answer and Meta wants a bot
 * reply inside 30. Retrieval is not allowed to spend a meaningful slice of that
 * on an optional recall improvement, so the vector stage gets two and a half
 * seconds and then the answer is written from BM25 alone.
 */
export const EMBED_QUERY_TIMEOUT_MS = 2_500;

/** Ingest and backfill are not racing a customer, so they get longer. */
export const EMBED_BATCH_TIMEOUT_MS = 30_000;

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export type FetchLike = (
  input: string,
  init: RequestInit
) => Promise<Response>;

interface EmbeddingConfig {
  /** Full URL of the deployed function. */
  url: string;
  /** Project key for the platform's own gate. Never logged. */
  apiKey: string;
  /** The function's own shared secret. Never logged. */
  sharedSecret: string;
}

/**
 * Where the Edge Function lives and what gets us in.
 *
 * Returns null when any part is missing, which is what makes embeddings
 * optional: a self-hoster who has not deployed the function, or a developer
 * running tests, gets BM25-only retrieval rather than an error. Nothing in this
 * file logs any of these values.
 */
function readConfig(): EmbeddingConfig | null {
  const explicit = process.env.SUPABASE_FUNCTIONS_URL;
  const projectUrl = process.env.SUPABASE_URL;
  const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sharedSecret = process.env.EMBED_SHARED_SECRET;

  if (!apiKey || !sharedSecret) return null;

  const base = explicit ?? (projectUrl ? `${projectUrl}/functions/v1` : null);
  if (!base) return null;

  return {
    url: `${base.replace(/\/+$/, "")}/embed`,
    apiKey,
    sharedSecret,
  };
}

/** True when the vector stage can run at all. Cheap enough to call per query. */
export function isEmbeddingConfigured(): boolean {
  return readConfig() !== null;
}

const responseSchema = z.object({
  model: z.string(),
  dimensions: z.number().int(),
  embeddings: z.array(
    z.object({
      embedding: z.array(z.number()),
      truncated: z.boolean(),
      windows: z.number().int(),
    })
  ),
});

export interface Embedding {
  values: number[];
  /** True when the Edge Function dropped text it could not fit. */
  truncated: boolean;
}

export interface EmbedOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

async function postBatch(
  config: EmbeddingConfig,
  inputs: string[],
  options: EmbedOptions
): Promise<Embedding[]> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);

  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      "x-embed-secret": config.sharedSecret,
    },
    body: JSON.stringify({ inputs }),
    signal: AbortSignal.timeout(options.timeoutMs ?? EMBED_BATCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The function's own message is already sanitised, but it is not repeated
    // here: a status is all a caller can act on and all a log should carry.
    throw new EmbeddingError(
      `The embedding service answered ${response.status}.`
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EmbeddingError("The embedding service returned invalid JSON.");
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new EmbeddingError("The embedding service returned an unexpected shape.");
  }

  if (parsed.data.dimensions !== EMBEDDING_DIMENSION) {
    throw new EmbeddingError(
      `The embedding service reported ${parsed.data.dimensions} dimensions, expected ${EMBEDDING_DIMENSION}. The model behind it has changed and every stored vector is now the wrong shape.`
    );
  }

  if (parsed.data.embeddings.length !== inputs.length) {
    throw new EmbeddingError(
      `The embedding service returned ${parsed.data.embeddings.length} vectors for ${inputs.length} inputs.`
    );
  }

  return parsed.data.embeddings.map((entry) => {
    if (entry.embedding.length !== EMBEDDING_DIMENSION) {
      throw new EmbeddingError(
        `The embedding service returned a ${entry.embedding.length} dimension vector, expected ${EMBEDDING_DIMENSION}.`
      );
    }
    for (const value of entry.embedding) {
      if (!Number.isFinite(value)) {
        throw new EmbeddingError("The embedding service returned a non-finite value.");
      }
    }
    return { values: entry.embedding, truncated: entry.truncated };
  });
}

/**
 * Embed a batch of texts. Throws on anything unexpected, because every caller
 * of this is about to write to the database.
 */
export async function embedTexts(
  texts: string[],
  options: EmbedOptions = {}
): Promise<Embedding[]> {
  if (texts.length === 0) return [];

  const config = readConfig();
  if (!config) {
    throw new EmbeddingError("The embedding service is not configured.");
  }

  const results: Embedding[] = [];
  for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_LIMIT) {
    const batch = texts.slice(offset, offset + EMBEDDING_BATCH_LIMIT);
    results.push(...(await postBatch(config, batch, options)));
  }
  return results;
}

/**
 * Embed one question for retrieval, or return null.
 *
 * Null is a first class outcome here, not an error path: the service being
 * unconfigured, slow, down or newly wrong-dimensioned all mean the same thing
 * to the caller, which is that this answer is written from BM25 alone. The
 * failure is logged, never swallowed, and never carries the question or a key.
 */
export async function embedQuery(
  question: string,
  options: EmbedOptions = {}
): Promise<number[] | null> {
  if (!isEmbeddingConfigured()) return null;

  try {
    const [embedding] = await embedTexts([question], {
      timeoutMs: options.timeoutMs ?? EMBED_QUERY_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
    });
    return embedding ? embedding.values : null;
  } catch (error) {
    console.warn("[embeddings] query embedding unavailable", {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof EmbeddingError ? error.message : undefined,
    });
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* SQL plumbing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The Postgres schema the app's tables live in.
 *
 * Prisma's pg adapter hands the schema name to the query engine, which
 * qualifies the SQL it generates itself. It does not set the connection's
 * search_path, so a raw query has to qualify its own tables or it will look in
 * whatever the role's default path is and find nothing. The name is validated
 * because it reaches SQL as an identifier rather than as a bound parameter.
 */
// Imported as well as re-exported: this file uses qualified() itself, and a
// bare re-export would not bind the name locally. Callers that have always
// imported it from here keep working.
export { appSchema, qualified };

/**
 * pgvector's text input format.
 *
 * Note what is deliberately absent everywhere this value is used: a `::vector`
 * cast. The extension lives in whichever schema the project installed it into,
 * commonly `extensions` on Supabase, and that schema is not necessarily on the
 * connection's search_path, so naming the type in SQL is the fragile option.
 * Passing the literal as an untyped parameter next to a vector column instead
 * lets Postgres infer the type from the operator or the assignment, which works
 * wherever the extension happens to live.
 */
export function toVectorLiteral(values: number[]): string {
  if (values.length !== EMBEDDING_DIMENSION) {
    throw new EmbeddingError(
      `Refusing to write a ${values.length} dimension vector into a vector(${EMBEDDING_DIMENSION}) column.`
    );
  }
  return `[${values.join(",")}]`;
}

/* -------------------------------------------------------------------------- */
/* Writing embeddings                                                         */
/* -------------------------------------------------------------------------- */

interface PendingChunk {
  id: string;
  content: string;
}

export interface EmbedWriteResult {
  /** Chunks that now have a vector. */
  embedded: number;
  /** Chunks whose text was too long to embed whole. Still stored. */
  truncated: number;
}

/**
 * Store vectors for a set of chunks, one statement each inside one
 * transaction. Prisma cannot express an `Unsupported` column in `update`, so
 * this is raw by necessity rather than by preference.
 */
async function writeEmbeddings(
  rows: { id: string; embedding: Embedding }[]
): Promise<void> {
  if (rows.length === 0) return;

  const table = qualified("KnowledgeChunk");
  await prisma.$transaction(
    rows.map((row) =>
      prisma.$executeRawUnsafe(
        `UPDATE ${table} SET "embedding" = $1 WHERE "id" = $2`,
        toVectorLiteral(row.embedding.values),
        row.id
      )
    )
  );
}

async function embedAndStore(
  chunks: PendingChunk[],
  options: EmbedOptions
): Promise<EmbedWriteResult> {
  let embedded = 0;
  let truncated = 0;

  for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_LIMIT) {
    const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_LIMIT);
    const vectors = await embedTexts(
      batch.map((chunk) => chunk.content),
      options
    );

    await writeEmbeddings(
      batch.map((chunk, index) => ({ id: chunk.id, embedding: vectors[index] }))
    );

    embedded += batch.length;
    truncated += vectors.filter((vector) => vector.truncated).length;
  }

  return { embedded, truncated };
}

/**
 * Embed every chunk of one source that does not have a vector yet.
 *
 * This is what ingest calls. It never throws: a knowledge source that was
 * crawled, chunked and stored is usable through BM25 whether or not the
 * embedder was reachable in that minute, and failing the ingest over an
 * optional recall improvement would be the wrong trade. What it does instead is
 * log, and leave the rows null so a later backfill picks them up.
 */
export async function embedChunksForSource(
  sourceId: string,
  options: EmbedOptions = {}
): Promise<EmbedWriteResult> {
  if (!isEmbeddingConfigured()) return { embedded: 0, truncated: 0 };

  try {
    const chunks = await prisma.$queryRawUnsafe<PendingChunk[]>(
      `SELECT "id", "content" FROM ${qualified("KnowledgeChunk")}
       WHERE "sourceId" = $1 AND "embedding" IS NULL
       ORDER BY "ordinal" ASC`,
      sourceId
    );

    return await embedAndStore(chunks, options);
  } catch (error) {
    console.error("[embeddings] could not embed a source's chunks", {
      sourceId,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof EmbeddingError ? error.message : undefined,
    });
    return { embedded: 0, truncated: 0 };
  }
}

export interface BackfillOptions extends EmbedOptions {
  /** Chunks fetched and embedded per round. Defaults to the batch limit. */
  batchSize?: number;
  /** Stop after this many chunks. Undefined means run until none are left. */
  maxChunks?: number;
  onProgress?: (embedded: number) => void;
}

/**
 * Fill in vectors for chunks ingested before embeddings existed.
 *
 * Deliberately not a migration. The migration adds a nullable column precisely
 * so that no existing row has to be touched to deploy, and rewriting hundreds
 * of thousands of rows through an HTTP service inside a migration transaction
 * would be a long lock over something the application already degrades around.
 * This is re-runnable, resumable and interruptible: it only ever selects rows
 * that are still null, so stopping it halfway costs nothing.
 */
export async function backfillChunkEmbeddings(
  options: BackfillOptions = {}
): Promise<EmbedWriteResult> {
  if (!isEmbeddingConfigured()) {
    throw new EmbeddingError("The embedding service is not configured.");
  }

  // Floored because it reaches SQL as a LIMIT literal rather than a parameter.
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? EMBEDDING_BATCH_LIMIT)
  );
  const ceiling =
    options.maxChunks === undefined ? undefined : Math.floor(options.maxChunks);
  const table = qualified("KnowledgeChunk");

  let embedded = 0;
  let truncated = 0;

  for (;;) {
    const remainingBudget =
      ceiling === undefined ? batchSize : Math.min(batchSize, ceiling - embedded);
    if (remainingBudget <= 0) break;

    const chunks = await prisma.$queryRawUnsafe<PendingChunk[]>(
      `SELECT "id", "content" FROM ${table}
       WHERE "embedding" IS NULL
       ORDER BY "createdAt" ASC, "id" ASC
       LIMIT ${remainingBudget}`
    );

    if (chunks.length === 0) break;

    const result = await embedAndStore(chunks, options);
    embedded += result.embedded;
    truncated += result.truncated;
    options.onProgress?.(embedded);

    if (chunks.length < remainingBudget) break;
  }

  return { embedded, truncated };
}
