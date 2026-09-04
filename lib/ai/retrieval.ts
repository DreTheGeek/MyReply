/**
 * Retrieval over KnowledgeChunk, in Postgres, with no vector store.
 *
 * Two stages, deliberately separated so each one can be wrong in a way the
 * other catches.
 *
 * 1. Recall. One indexed-ish Prisma query fetches every chunk in the workspace
 *    whose content contains any significant term from the question, as a plain
 *    case-insensitive substring. Substring matching over-fetches ("car" pulls
 *    "carpet") and that is the point: this stage is a net, not a judgement, and
 *    a cheap ILIKE needs no extension, no tsvector column and no migration.
 *
 * 2. Precision. Scoring runs in this process over that candidate pool using
 *    Okapi BM25 with word-boundary term matching, so the substring noise from
 *    stage one scores zero and drops out. Corpus statistics (document
 *    frequency, average length) come from the candidate pool rather than the
 *    whole table, which is the one approximation here and is noted again on
 *    `RetrievalResult.poolSize` so a caller can see how much evidence the
 *    statistics rest on.
 *
 * Explicitly NOT full text search: no `to_tsvector`, no `ts_rank`, no
 * `pg_trgm`. A tsvector expression index cannot be added without a migration,
 * and an unindexed `to_tsvector(content)` in a WHERE clause is a sequential
 * scan with a per-row parse cost on top of the one this already does. If a
 * migration ever becomes available, the swap is stage one only: replace the
 * `contains` OR with `websearch_to_tsquery` against a GIN index and leave the
 * scoring untouched.
 */

import { prisma } from "@/lib/db/client";

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
  /** Raw BM25 score. Comparable within one retrieval, not across two. */
  score: number;
  /** Query terms this chunk actually contains as whole words. */
  matchedTerms: string[];
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /**
   * Inverse-document-frequency weighted share of the question's content terms
   * that appear in the chunks handed to the model, 0 to 1. This is the
   * retrieval half of the confidence score.
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
 * Score a candidate pool that has already been fetched.
 *
 * Split out from the query so the ranking is testable without a database, and
 * so a future stage-one swap cannot change what "coverage" means.
 */
export function rankCandidates(
  question: string,
  candidates: CandidateRow[]
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

  const scored: RetrievedChunk[] = [];
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

    // A candidate that only matched as a substring contributes nothing and is
    // not context, so it never reaches the prompt.
    if (matchedTerms.length === 0) continue;

    scored.push({
      chunkId: item.row.id,
      sourceId: item.row.source.id,
      sourceTitle: item.row.source.title,
      citation: item.row.citation,
      content: item.row.content,
      score,
      matchedTerms,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));

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

/**
 * Fetch and rank the workspace's knowledge for one question.
 *
 * Only READY sources are searched. A PENDING crawl is half a document and a
 * FAILED one is whatever survived the failure, and answering a customer from
 * either is worse than not answering.
 */
export async function retrieveForQuestion(
  workspaceId: string,
  question: string
): Promise<RetrievalResult> {
  const terms = queryTerms(question);
  if (terms.length === 0) return { ...EMPTY_RETRIEVAL, terms };

  const candidates = await prisma.knowledgeChunk.findMany({
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
  });

  return rankCandidates(question, candidates);
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
