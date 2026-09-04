/**
 * Hybrid retrieval over KnowledgeChunk, in Postgres.
 *
 * Three stages now, deliberately separated so each one can be wrong in a way
 * the others catch.
 *
 * 1. Lexical recall. One Prisma query fetches every chunk in the workspace
 *    whose content contains any significant term from the question, as a plain
 *    case-insensitive substring. Substring matching over-fetches ("car" pulls
 *    "carpet") and that is the point: this stage is a net, not a judgement.
 *
 * 2. Semantic recall. A pgvector nearest-neighbour search over
 *    KnowledgeChunk.embedding, against an HNSW index under cosine distance.
 *    This is the stage that answers "how long till it arrives" with a passage
 *    about shipping times, which stage one cannot do at all because the two
 *    share no word. The embedding comes from a Supabase Edge Function running
 *    gte-small in the edge runtime, so it costs nothing per call and needs no
 *    third party API key. See lib/ai/embeddings.ts.
 *
 * 3. Precision and fusion. Scoring runs in this process over the union of the
 *    two candidate pools, using Okapi BM25 with word-boundary term matching, so
 *    the substring noise from stage one scores zero and drops out. The BM25
 *    ranking and the vector ranking are then fused with Reciprocal Rank Fusion.
 *    Corpus statistics (document frequency, average length) come from the
 *    candidate pool rather than the whole table, which is the one approximation
 *    here and is noted again on `RetrievalResult.poolSize` so a caller can see
 *    how much evidence the statistics rest on.
 *
 * WHY BOTH, AND WHY NEITHER ALONE. Embeddings are unreliable on exact strings:
 * a customer quoting SKU "XR-4400" needs the chunk containing that literal
 * token, and cosine similarity over a 384 dimension space is not the tool for
 * that. BM25 is unreliable on paraphrase: a customer who never says the word
 * "shipping" gets nothing from a term index. Each covers the other's blind
 * spot, and fusion is what lets them disagree without one silently winning.
 *
 * WHY RECIPROCAL RANK FUSION. The two stages produce scores on incomparable
 * scales: an unbounded BM25 sum against a cosine distance in [0, 2]. Any
 * weighted combination of the raw numbers needs a normalisation that is itself
 * a tuning parameter, and normalising per query makes the score depend on the
 * rest of the result set. RRF throws the magnitudes away and keeps only the
 * ranks, so there is nothing left to normalise. Its one constant, RRF_K, is
 * documented below.
 *
 * VECTOR SEARCH IS AN UPGRADE TO RECALL, NEVER A PRECONDITION FOR ANSWERING.
 * A chunk with no embedding, a workspace ingested before this existed, an
 * embedder that is down, unconfigured or timing out: all of these fall back to
 * exactly the retrieval this file did before, which is a complete and working
 * answer path rather than a degraded one.
 *
 * Explicitly still NOT full text search: no `to_tsvector`, no `ts_rank`. Stage
 * one remains a substring net, and stage three remains the judgement.
 */

import { prisma } from "@/lib/db/client";
import {
  embedQuery,
  isEmbeddingConfigured,
  qualified,
  toVectorLiteral,
} from "@/lib/ai/embeddings";

/** Chunks fetched before scoring. A ceiling on the cost of one bad question. */
export const CANDIDATE_LIMIT = 240;

/** Chunks handed to the model. More than this stops being context and starts being noise. */
export const CONTEXT_CHUNK_LIMIT = 5;

/** Characters of retrieved context in one prompt. */
export const CONTEXT_CHAR_LIMIT = 6000;

/** Query terms we search on. Long questions are mostly filler past this. */
export const MAX_QUERY_TERMS = 14;

/** BM25 term frequency saturation. The standard value. */
const BM25_K1 = 1.2;

/** BM25 length normalisation. The standard value. */
const BM25_B = 0.75;

/**
 * Nearest neighbours the vector stage asks for.
 *
 * Small on purpose. Fusion only ever hands CONTEXT_CHUNK_LIMIT chunks to the
 * model, and a semantic neighbour ranked fortieth is not going to survive that
 * against anything BM25 also found. Keeping it well under HNSW_EF_SEARCH is
 * also what stops the index from returning fewer rows than asked for.
 */
export const VECTOR_CANDIDATE_LIMIT = 40;

/**
 * HNSW's query-time candidate list.
 *
 * pgvector's default is 40, which is the bare minimum for a LIMIT of 40 and
 * leaves no room for the workspace filter to discard neighbours. 100 gives the
 * scan enough headroom that a tenant with a small share of the table still gets
 * a full result set, at a cost measured in single-digit milliseconds on a table
 * this size.
 */
const HNSW_EF_SEARCH = 100;

/**
 * Reciprocal Rank Fusion's rank discount.
 *
 * 60 is the value from Cormack, Clarke and Buettcher's original paper, chosen
 * there across TREC runs and left alone here for a specific reason: a large k
 * flattens the difference between adjacent ranks, so a chunk both stages found
 * at rank five outscores a chunk only one stage found at rank one. That is the
 * behaviour this system wants. Each stage is known to be confidently wrong in
 * its own way, and agreement between two independently wrong methods is worth
 * more than a top placement in either.
 */
const RRF_K = 60;

/**
 * Words carrying no retrieval signal. Kept short and English-only on purpose:
 * an aggressive list throws away terms that matter in a support question, and
 * BM25's inverse document frequency already discounts anything common in this
 * workspace's own knowledge base.
 */
const STOP_WORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "been", "but",
  "by", "can", "could", "did", "do", "does", "for", "from", "get", "got",
  "had", "has", "have", "how", "i", "if", "in", "is", "it", "its", "just",
  "me", "my", "of", "on", "or", "our", "so", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "up", "us", "was", "we",
  "were", "what", "when", "where", "which", "who", "why", "will", "with",
  "would", "you", "your",
]);

/**
 * Split text into raw comparable tokens.
 *
 * A lone digit survives the length filter that drops a lone letter, because a
 * price, a quantity or a turnaround time is the single most damaging thing for
 * a model to invent, and "3 working days" has to stay checkable. Everything
 * else folds to lowercase and loses punctuation.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 || /^[0-9]$/.test(token));
}

/**
 * The one piece of stemming here: a trailing plural or third-person "s".
 *
 * Deliberately not a real stemmer. Porter would fold "shipping" to "ship" and
 * "policies" to "polici", which is fine for an index built once and matched
 * against itself, and wrong for a substring recall query that has to survive a
 * round trip through Postgres. Stripping one "s" is safe in that round trip,
 * because the singular is a substring of the plural, so a query normalised to
 * "cost" still matches "costs" in the database while the scorer sees both as
 * the same term. Words ending "ss" are left alone so "business" and "address"
 * survive intact.
 */
export function normalizeTerm(token: string): string {
  if (token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Tokens worth searching or scoring on: no stop words, normalised.
 *
 * Stop words are removed before normalisation on purpose. "does" would
 * otherwise become "doe" and slip past the list.
 */
export function contentTerms(text: string): string[] {
  return tokenize(text)
    .filter((token) => !STOP_WORDS.has(token))
    .map(normalizeTerm);
}

/** Distinct content terms, capped, in first-seen order. */
export function queryTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of contentTerms(question)) {
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

/**
 * Term counts for one document, so BM25 can saturate repeats.
 *
 * Normalised but not stop-word filtered: a stop word in a chunk costs one map
 * entry and is never looked up, while filtering here would shorten the document
 * length that BM25 normalises against and quietly favour chatty passages.
 */
function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    const term = normalizeTerm(token);
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

/**
 * Inverse document frequency, in the smoothed form that cannot go negative.
 *
 * A term absent from the whole candidate pool gets the maximum weight, which is
 * what makes coverage fall for a question the knowledge base has nothing to say
 * about instead of quietly scoring it as "no evidence either way".
 */
function idf(documentFrequency: number, poolSize: number): number {
  return Math.log(1 + (poolSize + 1) / (documentFrequency + 1));
}

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  citation: string | null;
  content: string;
  /**
   * Raw BM25 score. Comparable within one retrieval, not across two. Zero for
   * a chunk only the vector stage found, which is not a judgement about it:
   * BM25 has nothing to say about a passage that shares no word with the
   * question.
   */
  score: number;
  /** Query terms this chunk actually contains as whole words. */
  matchedTerms: string[];
  /** Reciprocal Rank Fusion score. This is what the ordering is by. */
  fusedScore: number;
  /** 1-based place in the BM25 ranking, or null if BM25 did not rank it. */
  lexicalRank: number | null;
  /** 1-based place in the vector ranking, or null if the vector stage did not. */
  semanticRank: number | null;
  /** Cosine distance from the question, 0 to 2. Null without a vector hit. */
  distance: number | null;
}

/** One nearest neighbour, as the vector stage found it. */
export interface SemanticHit {
  chunkId: string;
  /** Cosine distance. Smaller is closer. */
  distance: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /**
   * Inverse-document-frequency weighted share of the question's content terms
   * that appear in the chunks handed to the model, 0 to 1. This is the
   * retrieval half of the confidence score.
   *
   * The definition is exactly what it was before hybrid retrieval existed, and
   * it is measured the same way, over the same thing: the chunks that reach the
   * prompt. What changed is only which chunks those are. Two consequences, both
   * deliberate, both in the safe direction:
   *
   * A chunk the vector stage found and BM25 did not contributes nothing here,
   * because it matched no query term as a whole word. Semantic recall can
   * therefore never inflate this number. If such a chunk takes a context slot
   * from a term-matching one, coverage falls, confidence falls, and the answer
   * is more likely to go to a human. That is the correct direction for a number
   * that decides whether a model may talk to a customer unsupervised.
   *
   * It can rise in one case: when the vector stage surfaces a chunk that does
   * contain query terms and that the lexical query missed because the candidate
   * pool hit CANDIDATE_LIMIT. That is retrieval genuinely finding evidence it
   * used to drop, which is the thing coverage exists to measure.
   */
  coverage: number;
  /** The terms the question was reduced to. Useful when explaining a low score. */
  terms: string[];
  /** Candidates scored. Small pools make the corpus statistics thin. */
  poolSize: number;
}

export const EMPTY_RETRIEVAL: RetrievalResult = {
  chunks: [],
  coverage: 0,
  terms: [],
  poolSize: 0,
};

interface CandidateRow {
  id: string;
  content: string;
  citation: string | null;
  source: { id: string; title: string };
}

/** Whole-word containment. Substring hits from the recall query score nothing. */
function hasTerm(counts: Map<string, number>, term: string): boolean {
  return (counts.get(term) ?? 0) > 0;
}

/**
 * Score and fuse a candidate pool that has already been fetched.
 *
 * Split out from the queries so the ranking is testable without a database or
 * an embedding service, and so a stage-one or stage-two swap cannot change what
 * "coverage" means.
 *
 * `semantic` is the vector stage's output, best first. Passing none is the
 * BM25-only path, and it produces byte for byte the ordering this function
 * produced before hybrid retrieval existed: with one list, an RRF score is
 * strictly decreasing in that list's rank, so sorting by it is sorting by BM25.
 * Chunk ids in `semantic` that are not in `candidates` are ignored, since there
 * is no row to put in a prompt.
 */
export function rankCandidates(
  question: string,
  candidates: CandidateRow[],
  semantic: readonly SemanticHit[] = []
): RetrievalResult {
  const terms = queryTerms(question);
  if (terms.length === 0 || candidates.length === 0) {
    return { ...EMPTY_RETRIEVAL, terms };
  }

  const counted = candidates.map((row) => ({
    row,
    counts: termCounts(row.content),
    length: tokenize(row.content).length,
  }));

  const poolSize = counted.length;
  const averageLength =
    counted.reduce((total, item) => total + item.length, 0) / poolSize || 1;

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let frequency = 0;
    for (const item of counted) {
      if (hasTerm(item.counts, term)) frequency += 1;
    }
    documentFrequency.set(term, frequency);
  }

  const weights = new Map<string, number>();
  for (const term of terms) {
    weights.set(term, idf(documentFrequency.get(term) ?? 0, poolSize));
  }

  // The vector stage's ranking, closest first, restricted to rows that are
  // actually in the pool. Duplicate ids keep their best place.
  const semanticRanks = new Map<string, number>();
  const semanticDistances = new Map<string, number>();
  const inPool = new Set(candidates.map((row) => row.id));
  const ordered = [...semantic]
    .filter((hit) => inPool.has(hit.chunkId))
    .sort((a, b) => a.distance - b.distance || a.chunkId.localeCompare(b.chunkId));

  for (const hit of ordered) {
    if (semanticRanks.has(hit.chunkId)) continue;
    semanticRanks.set(hit.chunkId, semanticRanks.size + 1);
    semanticDistances.set(hit.chunkId, hit.distance);
  }

  interface Candidate {
    chunk: RetrievedChunk;
    matched: boolean;
  }

  const graded: Candidate[] = [];
  for (const item of counted) {
    let score = 0;
    const matchedTerms: string[] = [];

    for (const term of terms) {
      const frequency = item.counts.get(term) ?? 0;
      if (frequency === 0) continue;
      matchedTerms.push(term);

      const norm = 1 - BM25_B + (BM25_B * item.length) / averageLength;
      score +=
        (weights.get(term) ?? 0) *
        ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * norm));
    }

    const semanticRank = semanticRanks.get(item.row.id) ?? null;

    // A candidate that matched no term as a whole word is not context and never
    // reaches the prompt, unless the vector stage put it there. That exception
    // is the entire point of the vector stage: "how long till it arrives" and a
    // passage about delivery times share no word, so a rule that requires a
    // lexical match would throw away every semantic hit worth having. What it
    // does not weaken is the substring guard, because a chunk pulled in by the
    // ILIKE net alone has no semantic rank and still drops out here.
    if (matchedTerms.length === 0 && semanticRank === null) continue;

    graded.push({
      matched: matchedTerms.length > 0,
      chunk: {
        chunkId: item.row.id,
        sourceId: item.row.source.id,
        sourceTitle: item.row.source.title,
        citation: item.row.citation,
        content: item.row.content,
        score,
        matchedTerms,
        fusedScore: 0,
        lexicalRank: null,
        semanticRank,
        distance: semanticDistances.get(item.row.id) ?? null,
      },
    });
  }

  // The BM25 ranking, in the order this file has always produced, over exactly
  // the candidates BM25 has an opinion about.
  const lexical = graded
    .filter((candidate) => candidate.matched)
    .map((candidate) => candidate.chunk)
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));

  lexical.forEach((chunk, index) => {
    chunk.lexicalRank = index + 1;
  });

  for (const candidate of graded) {
    const chunk = candidate.chunk;
    chunk.fusedScore =
      (chunk.lexicalRank === null ? 0 : 1 / (RRF_K + chunk.lexicalRank)) +
      (chunk.semanticRank === null ? 0 : 1 / (RRF_K + chunk.semanticRank));
  }

  // Fused score decides. BM25 breaks a tie, because a tie means the two stages
  // disagreed about which of two chunks to prefer and the lexical evidence is
  // the half we can show a human. The chunk id settles the rest, so the same
  // question over the same data always produces the same prompt.
  const scored = graded
    .map((candidate) => candidate.chunk)
    .sort(
      (a, b) =>
        b.fusedScore - a.fusedScore ||
        b.score - a.score ||
        a.chunkId.localeCompare(b.chunkId)
    );

  const chunks: RetrievedChunk[] = [];
  let characters = 0;
  for (const chunk of scored) {
    if (chunks.length >= CONTEXT_CHUNK_LIMIT) break;
    if (characters + chunk.content.length > CONTEXT_CHAR_LIMIT && chunks.length > 0) {
      break;
    }
    chunks.push(chunk);
    characters += chunk.content.length;
  }

  const covered = new Set<string>();
  for (const chunk of chunks) {
    for (const term of chunk.matchedTerms) covered.add(term);
  }

  let totalWeight = 0;
  let coveredWeight = 0;
  for (const term of terms) {
    const weight = weights.get(term) ?? 0;
    totalWeight += weight;
    if (covered.has(term)) coveredWeight += weight;
  }

  const coverage = totalWeight > 0 ? coveredWeight / totalWeight : 0;

  return { chunks, coverage, terms, poolSize };
}

/** Injection points, so retrieval is testable without a network. */
export interface RetrievalDeps {
  /** Returns the question's vector, or null when the embedder cannot help. */
  embed?: (question: string) => Promise<number[] | null>;
}

interface SemanticRow {
  id: string;
  content: string;
  citation: string | null;
  sourceId: string;
  sourceTitle: string;
  distance: number;
}

/**
 * Nearest neighbours in the workspace, by cosine distance.
 *
 * Raw SQL because Prisma cannot express pgvector's `<=>` operator, and because
 * an `Unsupported` column cannot appear in a Prisma filter at all.
 *
 * Three details that are not obvious:
 *
 * The tables are schema qualified. Prisma's pg adapter hands the schema name to
 * the query engine rather than setting the connection's search_path, so raw SQL
 * has to say where it is looking.
 *
 * The vector parameter carries no `::vector` cast. The extension may be
 * installed in a schema the connection cannot see unqualified, so the type is
 * left for Postgres to infer from the operator, which works wherever the
 * extension lives.
 *
 * The two settings are not tuning for its own sake. `hnsw.iterative_scan` is
 * what makes a filtered vector search correct on a multi-tenant table: without
 * it the index returns its global nearest neighbours and the workspace filter
 * then discards them, so a small tenant can get an empty result while its own
 * perfectly good chunks sit unvisited. `relaxed_order` is the cheaper of the two
 * scan modes and costs nothing here because the rows are re-sorted by distance
 * in this process anyway.
 */
async function searchByVector(
  workspaceId: string,
  vector: number[]
): Promise<SemanticRow[]> {
  const sql = `
    SELECT c."id",
           c."content",
           c."citation",
           s."id" AS "sourceId",
           s."title" AS "sourceTitle",
           (c."embedding" <=> $1) AS "distance"
    FROM ${qualified("KnowledgeChunk")} c
    JOIN ${qualified("KnowledgeSource")} s ON s."id" = c."sourceId"
    WHERE s."workspaceId" = $2
      AND s."status" = 'READY'
      AND c."embedding" IS NOT NULL
    ORDER BY c."embedding" <=> $1
    LIMIT ${VECTOR_CANDIDATE_LIMIT}
  `;

  const [, , rows] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`),
    prisma.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'"),
    prisma.$queryRawUnsafe<SemanticRow[]>(
      sql,
      toVectorLiteral(vector),
      workspaceId
    ),
  ]);

  return [...rows].sort((a, b) => a.distance - b.distance);
}

/**
 * The semantic half of recall, or nothing.
 *
 * Every failure here returns an empty list, and the caller carries on with
 * BM25. That is not defensiveness, it is the contract: a workspace whose
 * content was ingested before embeddings existed has no vectors at all, and it
 * has to keep answering exactly as well as it did yesterday. The failures are
 * logged rather than swallowed, without the question and without a key.
 */
async function semanticCandidates(
  workspaceId: string,
  question: string,
  embed: (question: string) => Promise<number[] | null>
): Promise<SemanticRow[]> {
  if (!isEmbeddingConfigured()) return [];

  try {
    const vector = await embed(question);
    if (!vector) return [];
    return await searchByVector(workspaceId, vector);
  } catch (error) {
    console.warn("[retrieval] vector stage unavailable, using BM25 alone", {
      workspaceId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return [];
  }
}

/**
 * Fetch and rank the workspace's knowledge for one question.
 *
 * Only READY sources are searched, in both stages. A PENDING crawl is half a
 * document and a FAILED one is whatever survived the failure, and answering a
 * customer from either is worse than not answering.
 *
 * The two recall stages run concurrently, so the vector stage costs the wall
 * clock difference between the two rather than the sum. A question with no
 * content terms still returns before either of them: nothing worth searching on
 * means nothing worth spending an embedding call on.
 */
export async function retrieveForQuestion(
  workspaceId: string,
  question: string,
  deps: RetrievalDeps = {}
): Promise<RetrievalResult> {
  const terms = queryTerms(question);
  if (terms.length === 0) return { ...EMPTY_RETRIEVAL, terms };

  const embed = deps.embed ?? ((text: string) => embedQuery(text));

  const [candidates, semantic] = await Promise.all([
    prisma.knowledgeChunk.findMany({
      where: {
        source: { workspaceId, status: "READY" },
        OR: terms.map((term) => ({
          content: { contains: term, mode: "insensitive" as const },
        })),
      },
      select: {
        id: true,
        content: true,
        citation: true,
        source: { select: { id: true, title: true } },
      },
      take: CANDIDATE_LIMIT,
    }),
    semanticCandidates(workspaceId, question, embed),
  ]);

  // One pool, so BM25's corpus statistics are estimated over everything either
  // stage thought was relevant rather than over the lexical half alone.
  const pool: CandidateRow[] = [...candidates];
  const seen = new Set(pool.map((row) => row.id));
  for (const row of semantic) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    pool.push({
      id: row.id,
      content: row.content,
      citation: row.citation,
      source: { id: row.sourceId, title: row.sourceTitle },
    });
  }

  return rankCandidates(
    question,
    pool,
    semantic.map((row) => ({ chunkId: row.id, distance: row.distance }))
  );
}

/**
 * How much of an answer's own vocabulary is present in the chunks it was
 * written from, 0 to 1. The generation half of the confidence score.
 *
 * Purely textual and computed after the model has spoken, so it measures the
 * answer rather than trusting a self-report. An answer with no content terms at
 * all ("Yes, we do.") scores 1: it asserted nothing that could be unsupported.
 */
export function groundedness(answer: string, chunks: RetrievedChunk[]): number {
  const answerTerms = new Set(contentTerms(answer));
  if (answerTerms.size === 0) return 1;

  const supported = new Set(contentTerms(chunks.map((c) => c.content).join("\n")));

  let found = 0;
  for (const term of answerTerms) {
    if (supported.has(term)) found += 1;
  }

  return found / answerTerms.size;
}
