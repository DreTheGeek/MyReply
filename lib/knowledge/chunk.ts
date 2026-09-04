/**
 * Splitting ingested text into retrievable passages.
 *
 * Chunking happens once, at ingest, so answering never pays to split a document
 * and so every passage can carry the citation it came from. The target window is
 * 500 to 1000 characters: small enough that several fit in a prompt alongside a
 * conversation, large enough that a single passage still answers a question on
 * its own.
 *
 * Boundaries are chosen in descending order of preference: paragraph, then
 * sentence, then word, then a hard cut. A hard cut only ever happens inside a
 * single word longer than the window, which in practice means a URL or a hash.
 */

export const MIN_CHUNK_CHARS = 500;
export const MAX_CHUNK_CHARS = 1000;

/** A passage plus where it came from, ready to become a KnowledgeChunk row. */
export interface TextChunk {
  content: string;
  citation: string;
}

export interface ChunkOptions {
  minChars?: number;
  maxChars?: number;
}

/**
 * Normalise whitespace without destroying paragraph structure. Blank lines are
 * the strongest boundary signal we have, so they survive while every other run
 * of whitespace collapses.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** Greedily pack pieces into runs no longer than `maxChars`. */
function pack(pieces: string[], separator: string, maxChars: number): string[] {
  const packed: string[] = [];
  let buffer = "";

  for (const piece of pieces) {
    if (buffer === "") {
      buffer = piece;
      continue;
    }
    if (buffer.length + separator.length + piece.length <= maxChars) {
      buffer += separator + piece;
      continue;
    }
    packed.push(buffer);
    buffer = piece;
  }

  if (buffer !== "") packed.push(buffer);
  return packed;
}

/** Last resort: cut a single token that is longer than the whole window. */
function sliceToken(token: string, maxChars: number): string[] {
  const slices: string[] = [];
  for (let offset = 0; offset < token.length; offset += maxChars) {
    slices.push(token.slice(offset, offset + maxChars));
  }
  return slices;
}

/**
 * Break one over-long paragraph down until every piece fits, preferring
 * sentence ends, then word gaps.
 */
function splitOversizedParagraph(
  paragraph: string,
  maxChars: number
): string[] {
  const sentences = paragraph
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  const settled: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      settled.push(sentence);
      continue;
    }

    const words = sentence.split(/\s+/).filter((word) => word.length > 0);
    const tokens: string[] = [];
    for (const word of words) {
      if (word.length <= maxChars) tokens.push(word);
      else tokens.push(...sliceToken(word, maxChars));
    }
    settled.push(...pack(tokens, " ", maxChars));
  }

  return pack(settled, " ", maxChars);
}

/**
 * Turn a document into passages. Paragraphs are merged upward until a chunk is
 * at least `minChars`, and never merged past `maxChars`. The final chunk may be
 * shorter than the minimum, because a document has to end somewhere.
 */
export function chunkText(
  input: string,
  citation: string,
  options: ChunkOptions = {}
): TextChunk[] {
  const minChars = options.minChars ?? MIN_CHUNK_CHARS;
  const maxChars = options.maxChars ?? MAX_CHUNK_CHARS;

  const normalized = normalizeText(input);
  if (normalized === "") return [];

  const pieces: string[] = [];
  for (const paragraph of splitParagraphs(normalized)) {
    if (paragraph.length <= maxChars) pieces.push(paragraph);
    else pieces.push(...splitOversizedParagraph(paragraph, maxChars));
  }

  const chunks: string[] = [];
  let buffer = "";

  for (const piece of pieces) {
    if (buffer === "") {
      buffer = piece;
      continue;
    }

    // Already a usable passage, so start a fresh one rather than glue two
    // unrelated paragraphs together just because they happen to fit.
    if (buffer.length >= minChars) {
      chunks.push(buffer);
      buffer = piece;
      continue;
    }

    if (buffer.length + 2 + piece.length <= maxChars) {
      buffer += `\n\n${piece}`;
      continue;
    }

    chunks.push(buffer);
    buffer = piece;
  }

  if (buffer !== "") chunks.push(buffer);

  return chunks.map((content) => ({ content, citation }));
}

/**
 * A question and answer pair is always exactly one chunk. Splitting it would
 * separate the question from its answer, which is the one thing that must not
 * happen to retrievable text.
 */
export function chunkQuestionAndAnswer(
  question: string,
  answer: string
): TextChunk {
  const trimmedQuestion = question.trim();
  return {
    content: `Q: ${trimmedQuestion}\nA: ${answer.trim()}`,
    citation: trimmedQuestion,
  };
}
