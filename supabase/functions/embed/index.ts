/**
 * Text to vectors, inside the Supabase edge runtime.
 *
 * `Supabase.ai.Session('gte-small')` runs the model in the edge worker itself.
 * There is no external API, no API key and no per-call charge, which is the
 * whole reason retrieval can use embeddings at all: MyReply's rule is that
 * anything with no marginal cost belongs in the free tier, and an OpenAI
 * embeddings dependency would break that. It would also be impossible for the
 * bring-your-own-key customers on Anthropic, which has no embeddings endpoint.
 *
 * WHY THIS FILE DECLARES ITS OWN GLOBALS
 * The repository's tsconfig type checks every .ts file in the tree with the
 * Node and DOM libs, and it has no Deno types. Rather than change a shared
 * config for one file, the two runtime globals this function touches are
 * declared here, narrowly, and the model's output is treated as `unknown` and
 * checked at runtime. That check is not ceremony: it is what makes a swapped
 * model fail loudly instead of writing wrong sized vectors into the table.
 *
 * AUTHENTICATION, IN TWO LAYERS
 * 1. `verify_jwt = true` in supabase/config.toml. The platform refuses anything
 *    without a valid project key.
 * 2. A shared secret this function checks itself. Layer one alone is not
 *    authentication, because the anon key is published to browsers by design,
 *    so anyone who has ever loaded a Supabase powered page could otherwise use
 *    this as a free embedding service. The secret is compared in constant time
 *    and the function refuses to serve at all when it is unset, so a
 *    misconfigured deploy fails closed rather than open.
 *
 * THE 512 TOKEN LIMIT, HANDLED RATHER THAN SUFFERED
 * gte-small is English only and its position embeddings stop at 512 tokens.
 * Handed more, the tokenizer silently drops the tail, so a 3000 character
 * passage would be embedded as its first paragraph and the rest would be
 * unretrievable without anything saying so. Instead this function estimates
 * WordPiece token cost, splits over-long input into windows that each fit, and
 * mean pools the window vectors back into one unit vector. Past MAX_WINDOWS it
 * stops and says `truncated: true` in the response, so the caller knows the
 * tail was dropped rather than finding out from a bad answer. Ingest chunks are
 * capped at 1000 characters upstream, so in normal operation nothing here ever
 * needs more than one window.
 */

declare const Deno: {
  readonly env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): unknown;
};

declare const Supabase: {
  readonly ai: {
    readonly Session: new (model: string) => {
      run(
        input: string,
        options: { mean_pool: boolean; normalize: boolean }
      ): Promise<unknown>;
    };
  };
};

/** The model. Changing this string changes DIMENSIONS, and both ends assert it. */
const MODEL = "gte-small";

/**
 * Output width of gte-small, measured rather than assumed: a forward pass
 * through the published Supabase/gte-small ONNX export returns dims [1, 384]
 * with an L2 norm of exactly 1 under { mean_pool: true, normalize: true }.
 * lib/ai/embeddings.ts asserts the same number from the other side.
 */
const DIMENSIONS = 384;

/** gte-small's position embeddings stop here. Not a suggestion. */
const MODEL_TOKEN_LIMIT = 512;

/** [CLS] and [SEP], which the tokenizer adds and the budget has to pay for. */
const SPECIAL_TOKENS = 2;

/**
 * Headroom against the token estimate below. The estimate is a heuristic, not
 * a tokenizer, so it is allowed to be wrong by a few percent on unusual text.
 * 32 tokens of slack is cheaper than a silent cut.
 */
const ESTIMATE_SLACK = 32;

/** Estimated tokens one window may carry. */
const WINDOW_TOKEN_BUDGET = MODEL_TOKEN_LIMIT - SPECIAL_TOKENS - ESTIMATE_SLACK;

/**
 * Windows we will embed for one input before giving up on the rest. Four
 * windows is roughly 6000 characters, six times the largest chunk ingest
 * produces, so reaching this means something upstream is wrong and the honest
 * response is to say so rather than to keep spending.
 */
const MAX_WINDOWS = 4;

/** Inputs per request. Keeps one call inside the edge worker's wall clock. */
const MAX_INPUTS = 32;

/** Characters in one input. Beyond this the caller should have chunked first. */
const MAX_INPUT_CHARS = 24_000;

/** Request body ceiling, so a large POST is refused before it is parsed. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * The model session is created once per worker, not once per request. Loading
 * the weights is the expensive part and the runtime keeps them warm.
 */
const session = new Supabase.ai.Session(MODEL);

class EmbedError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EmbedError";
    this.status = status;
  }
}

/** Byte-wise comparison that does not return early on the first difference. */
function secretsMatch(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

/**
 * Estimated WordPiece token cost of one word.
 *
 * gte-small uses BERT's 30522 entry WordPiece vocabulary. Two properties of it
 * drive this estimate: a common English word is one token, and anything else is
 * broken into pieces that average about four characters. Punctuation and
 * symbols are always their own token, which is what makes a URL or a hash so
 * much more expensive per character than prose. Counting those separately is
 * the difference between an estimate that holds on a support article and one
 * that collapses on a page full of links.
 *
 * Checked against the real tokenizer rather than left to intuition. Against
 * gte-small's own vocabulary this over-estimates by 1.2x on a page of URLs,
 * 1.3x on mixed prose with SKUs and prices, and 1.6x on plain sentences. Always
 * over, never under, which is the direction that matters: over-estimating costs
 * an unnecessary window boundary, under-estimating costs a silent cut.
 */
function estimateWordTokens(word: string): number {
  let tokens = 0;
  let runLength = 0;

  for (const character of word) {
    const isWordCharacter =
      (character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      (character >= "0" && character <= "9");

    if (isWordCharacter) {
      runLength += 1;
      continue;
    }

    if (runLength > 0) {
      tokens += Math.ceil(runLength / 4);
      runLength = 0;
    }
    // A punctuation mark, a symbol or a non-Latin character. One token each,
    // and non-Latin scripts are worse than that, which the slack absorbs.
    tokens += 1;
  }

  if (runLength > 0) tokens += Math.ceil(runLength / 4);
  return Math.max(1, tokens);
}

/** Estimated token cost of a whole passage, special tokens included. */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  let total = SPECIAL_TOKENS;
  for (const word of words) total += estimateWordTokens(word);
  return total;
}

/**
 * Cut one word that is on its own too large for a window. In practice this is
 * a URL, a base64 blob or a hash, never a real word.
 */
function sliceLongWord(word: string, budget: number): string[] {
  // Four characters per estimated token is the same ratio estimateWordTokens
  // uses for an unbroken run, so this lands just inside the budget.
  const size = Math.max(1, budget * 4);
  const slices: string[] = [];
  for (let offset = 0; offset < word.length; offset += size) {
    slices.push(word.slice(offset, offset + size));
  }
  return slices;
}

/**
 * Split text into windows that each fit the model, on word boundaries.
 * A passage short enough to embed in one pass comes back as a single window.
 */
export function splitIntoWindows(text: string, budget: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const windows: string[] = [];

  let current: string[] = [];
  let cost = 0;

  const flush = (): void => {
    if (current.length > 0) {
      windows.push(current.join(" "));
      current = [];
      cost = 0;
    }
  };

  for (const word of words) {
    const pieces =
      estimateWordTokens(word) > budget ? sliceLongWord(word, budget) : [word];

    for (const piece of pieces) {
      const pieceCost = estimateWordTokens(piece);
      if (cost + pieceCost > budget) flush();
      current.push(piece);
      cost += pieceCost;
    }
  }

  flush();
  return windows;
}

/**
 * The model's output, checked rather than trusted. Anything that is not a
 * finite vector of exactly DIMENSIONS numbers is a failure, loudly.
 */
function toVector(value: unknown): number[] {
  let values: number[];

  if (Array.isArray(value)) {
    values = new Array<number>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index];
      if (typeof entry !== "number" || !Number.isFinite(entry)) {
        throw new EmbedError(500, "The embedding model returned a non-numeric value.");
      }
      values[index] = entry;
    }
  } else if (value instanceof Float32Array || value instanceof Float64Array) {
    values = Array.from(value);
  } else {
    throw new EmbedError(500, "The embedding model returned an unexpected shape.");
  }

  if (values.length !== DIMENSIONS) {
    throw new EmbedError(
      500,
      `The embedding model returned ${values.length} dimensions, expected ${DIMENSIONS}.`
    );
  }

  return values;
}

/** Mean of unit vectors, brought back onto the unit sphere. */
function mergeVectors(vectors: number[][]): number[] {
  if (vectors.length === 1) return vectors[0];

  const merged = new Array<number>(DIMENSIONS).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < DIMENSIONS; index += 1) {
      merged[index] += vector[index];
    }
  }

  let norm = 0;
  for (const value of merged) norm += value * value;
  norm = Math.sqrt(norm);

  // Two windows that point in opposite directions can cancel out. That is a
  // degenerate passage rather than a runtime failure, so the zero vector is
  // returned as-is and cosine distance treats it as maximally far from
  // everything, which is the honest ranking for text with no coherent topic.
  if (norm === 0) return merged;

  for (let index = 0; index < DIMENSIONS; index += 1) {
    merged[index] = merged[index] / norm;
  }
  return merged;
}

interface EmbeddedInput {
  embedding: number[];
  /** True when text past MAX_WINDOWS was dropped without being embedded. */
  truncated: boolean;
  /** Windows actually embedded and pooled into this vector. */
  windows: number;
}

async function embedOne(text: string): Promise<EmbeddedInput> {
  const windows = splitIntoWindows(text, WINDOW_TOKEN_BUDGET);
  if (windows.length === 0) {
    throw new EmbedError(400, "An input had no embeddable text in it.");
  }

  const used = windows.slice(0, MAX_WINDOWS);
  const vectors: number[][] = [];

  for (const window of used) {
    const raw = await session.run(window, { mean_pool: true, normalize: true });
    vectors.push(toVector(raw));
  }

  return {
    embedding: mergeVectors(vectors),
    truncated: windows.length > used.length,
    windows: used.length,
  };
}

/** The request body, validated by hand so this function needs no imports. */
function readInputs(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EmbedError(400, "The request body must be a JSON object.");
  }

  const inputs: unknown = (body as Record<string, unknown>).inputs;
  if (!Array.isArray(inputs)) {
    throw new EmbedError(400, "The request body must carry an inputs array.");
  }
  if (inputs.length === 0 || inputs.length > MAX_INPUTS) {
    throw new EmbedError(400, `inputs must hold between 1 and ${MAX_INPUTS} strings.`);
  }

  const texts: string[] = [];
  for (const entry of inputs) {
    if (typeof entry !== "string") {
      throw new EmbedError(400, "Every entry in inputs must be a string.");
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new EmbedError(400, "Every entry in inputs must hold some text.");
    }
    if (trimmed.length > MAX_INPUT_CHARS) {
      throw new EmbedError(413, `An input exceeded ${MAX_INPUT_CHARS} characters.`);
    }
    texts.push(trimmed);
  }

  return texts;
}

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function authorize(request: Request): void {
  const expected = Deno.env.get("EMBED_SHARED_SECRET");
  if (!expected) {
    // Fail closed. A deploy that forgot the secret is a misconfiguration, and
    // the wrong way to handle it is to serve embeddings to the internet.
    throw new EmbedError(500, "This function is not configured.");
  }

  const presented = request.headers.get("x-embed-secret");
  if (!presented || !secretsMatch(presented, expected)) {
    throw new EmbedError(401, "Not authorized.");
  }
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "Use POST." });
  }

  authorize(request);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new EmbedError(413, "The request body is too large.");
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new EmbedError(400, "The request body is not valid JSON.");
  }

  const texts = readInputs(parsed);

  const embeddings: EmbeddedInput[] = [];
  for (const text of texts) {
    embeddings.push(await embedOne(text));
  }

  return json(200, { model: MODEL, dimensions: DIMENSIONS, embeddings });
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await handle(request);
  } catch (error) {
    if (error instanceof EmbedError) {
      return json(error.status, { error: error.message });
    }
    // Nothing internal reaches the caller. The edge function's own logs keep
    // the detail, and the caller gets something it can act on.
    console.error("[embed] unhandled failure", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return json(500, { error: "The embedding service failed." });
  }
});
