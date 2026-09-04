# Retrieval and grounding

How MyReply finds the passages a model is allowed to answer a customer from, why
it uses two search methods rather than one, and what happens when half of it is
unavailable.

## The shape of it

```
                                question
                                    |
                +-------------------+-------------------+
                |                                       |
        lexical recall                          semantic recall
     ILIKE over KnowledgeChunk          gte-small vector, HNSW cosine
     (substring net, 240 max)           (nearest 40 in the workspace)
                |                                       |
                +-------------------+-------------------+
                                    |
                          one candidate pool
                                    |
                         BM25 scoring, IDF weights
                                    |
                    Reciprocal Rank Fusion of the two rankings
                                    |
                   top 5 chunks, 6000 characters, plus coverage
                                    |
                            lib/ai/answering.ts
```

Everything lives in `lib/ai/retrieval.ts` and `lib/ai/embeddings.ts`. The model
that produces vectors lives in `supabase/functions/embed`.

## Why hybrid

The two methods fail in opposite directions, and each failure is one this
product actually hits.

**BM25 cannot match a paraphrase.** A customer asking "how long till it arrives"
shares no word with a passage titled "Shipping and delivery times". A term index
scores that pair at zero, so before this existed the honest outcome was a
handoff for a question the business had already answered on its own website.

**Embeddings cannot be trusted on exact strings.** A customer quoting SKU
"XR-4400" or an order number needs the chunk that literally contains that token.
Cosine similarity in a 384 dimensional space treats near-identical codes as
near-identical points, which is precisely wrong when the difference between two
codes is the whole question.

So both run, and the results are fused. BM25 was not replaced and none of its
reasoning was undone: the IDF weighting, the word-boundary matching and the
single-character stemming rule are all still there, still doing the same job,
and still tested.

### Why Reciprocal Rank Fusion

The two stages produce numbers on incomparable scales: an unbounded BM25 sum
against a cosine distance in [0, 2]. Any weighted blend of the raw scores needs a
normalisation, and normalising per query makes each chunk's score depend on the
rest of the result set. RRF discards magnitudes and keeps only ranks, so there is
nothing left to normalise:

```
fused(chunk) = 1 / (60 + bm25_rank) + 1 / (60 + vector_rank)
```

A chunk missing from one list simply contributes nothing from that term. The
constant 60 is from the original Cormack, Clarke and Buettcher paper, and it is
kept because of what it does rather than because it is the default: a large
constant flattens the gap between adjacent ranks, so a chunk both stages placed
fifth outranks a chunk only one stage placed first. Given that each stage is
known to be confidently wrong in its own way, agreement between them is the
strongest evidence available.

Ties break on BM25 score, then on chunk id, so the same question over the same
data always builds the same prompt.

## What confidence means now

`lib/ai/answering.ts` gates whether a model may reply to a customer unsupervised.
Its confidence is `sqrt(coverage * groundedness)`, both measured from text after
the fact, neither reported by the model. Retrieval owns `coverage`.

**The definition of coverage did not change.** It is still the inverse-document-
frequency weighted share of the question's content terms that appear, as whole
words, in the chunks handed to the model. It is computed by the same code over
the same thing.

What changed is which chunks reach the prompt, which has two consequences worth
stating precisely:

- A chunk the vector stage found and BM25 did not carries none of the question's
  terms by construction, so it contributes zero to coverage. **Semantic recall
  can never inflate confidence.** If such a chunk takes a context slot from a
  term-matching one, coverage falls, confidence falls, and the answer is more
  likely to go to a human. For a number that decides whether a model talks to a
  customer alone, that is the correct direction to be wrong in.
- Coverage can rise in exactly one case: the vector stage surfaces a chunk that
  does contain query terms and that the lexical query dropped because the
  candidate pool hit its 240 row ceiling. That is retrieval genuinely finding
  evidence it used to lose, which is the thing coverage exists to measure.

BM25's corpus statistics are now estimated over the union of both pools rather
than the lexical pool alone, which is a strictly better estimate of the same
quantity. `RetrievalResult.poolSize` still reports how much evidence those
statistics rest on.

## Embeddings

`gte-small`, run by `Supabase.ai.Session` inside the Supabase edge runtime.

- **384 dimensions.** Measured, not assumed: a forward pass through the published
  `Supabase/gte-small` ONNX export, the same artifact the edge runtime loads,
  returns dims `[1, 384]` with an L2 norm of `1.000000` under
  `{ mean_pool: true, normalize: true }`. The number appears in the column width,
  in `EMBEDDING_DIMENSION`, and in the Edge Function, and is asserted on every
  response. Swapping the model breaks loudly instead of writing wrong sized
  vectors.
- **No API key and no per-call cost.** The model runs in the edge worker. That is
  the reason retrieval can use embeddings at all: MyReply's rule is that anything
  with no marginal cost belongs in the free tier, and an OpenAI embeddings
  dependency would break that, as well as being impossible for bring-your-own-key
  customers on Anthropic, which has no embeddings endpoint.
- **English only, 512 tokens.** See below.

### The 512 token limit

gte-small's position embeddings stop at 512 tokens and the tokenizer silently
drops everything past that. Handed a 3000 character passage it would embed the
first paragraph and nothing would say so.

The Edge Function does not allow that to happen quietly. It estimates WordPiece
token cost (alphanumeric runs at roughly four characters per piece, punctuation
and symbols at one token each, which is what makes URLs and hashes expensive),
splits over-long input into windows that each fit with 32 tokens of slack, embeds
each window, and mean pools the results back onto the unit sphere. Past four
windows, about 6000 characters, it stops and sets `truncated: true` on that
input so the caller knows the tail was dropped.

The estimate was checked against gte-small's actual tokenizer rather than left
to intuition. It over-counts by 1.2x on a page of URLs, 1.3x on mixed prose with
SKUs and prices, and 1.6x on plain sentences. Always over, never under, which is
the direction that matters: over-estimating costs an unnecessary window
boundary, under-estimating costs a silent cut.

In normal operation none of this fires. `lib/knowledge/chunk.ts` caps a passage at
1000 characters, which is roughly 250 tokens, and `answering.ts` caps a customer
question at 1200 characters.

## When the embedder is unavailable

Vector search is an upgrade to recall. It is never a precondition for answering.

Every one of these falls back to BM25-only retrieval, which is a complete answer
path rather than a degraded one:

| Situation | What happens |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or `EMBED_SHARED_SECRET` unset | The vector stage is skipped without a request being made. |
| The Edge Function is not deployed, or returns an error | Logged as a warning, the stage returns no candidates. |
| The call exceeds 2.5 seconds | Aborted. Answering has 20 seconds in total and will not spend a meaningful slice of it on an optional improvement. |
| The model width changed | Refused, logged, treated as no candidates. Nothing wrong sized is ever stored. |
| The workspace was ingested before this existed | Every embedding is null, the vector query returns nothing, retrieval works exactly as it did before. |
| A single chunk has no embedding | It competes on BM25 alone, and can still win. |

All of it is covered by `__tests__/retrieval-hybrid.test.ts` and
`__tests__/embeddings.test.ts`.

## Deploying the Edge Function

Set the function's own secret first. It is what actually closes the endpoint:
`verify_jwt = true` makes Supabase reject anything without a project key, but the
anon key is published to browsers by design, so it is not authentication on its
own. The function refuses to serve at all when the secret is unset, so a
misconfigured deploy fails closed.

```bash
# A new random secret. Store it somewhere you can read it back.
npx supabase secrets set EMBED_SHARED_SECRET="$(openssl rand -hex 32)" --project-ref <project-ref>

# Deploy.
npx supabase functions deploy embed --project-ref <project-ref>
```

Then give the application the same three values:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<the project's service role key>
EMBED_SHARED_SECRET=<the secret set above>
```

`SUPABASE_FUNCTIONS_URL` overrides the derived `${SUPABASE_URL}/functions/v1` if
the functions host differs.

Smoke test:

```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/embed" \
  -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "x-embed-secret: $EMBED_SHARED_SECRET" \
  -H "content-type: application/json" \
  -d '{"inputs":["how long till it arrives"]}' \
  | head -c 200
```

The response opens with `{"model":"gte-small","dimensions":384,...`. Anything
else, particularly a different `dimensions`, means the application will refuse
every vector it returns, which is the intended behaviour.

## The database

The migration is `prisma/migrations/20260904230000_add_chunk_embeddings`. It adds
one nullable column and one index:

```sql
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embedding" vector(384);
CREATE INDEX ... USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 80);
```

both wrapped in a `DO` block that looks the vector extension's schema up in the
catalog and qualifies the type with it. Supabase installs the extension into
`extensions`, a self-hosted Postgres usually into `public`, and migrations run
with a search path pointed at the application schema, so a bare `vector(384)`
would work on one deployment and fail on another.

**HNSW, not IVFFlat.** IVFFlat has to be built against data that already exists,
and this column starts entirely null. HNSW is built incrementally as rows are
written, which is what a nullable column filled in by a background backfill
needs.

**Cosine distance**, because gte-small returns unit vectors and cosine keeps
agreeing with inner product if a future model stops normalising.

**m = 16**, pgvector's default, kept deliberately: recall against 384 dimensional
vectors is flat above roughly this value until a table reaches millions of rows,
and MyReply caps a source at 5000 chunks. **ef_construction = 80** rather than the
default 64, because it buys graph quality, and therefore recall at any query-time
`ef_search`, at zero query cost. The price is paid per insert, and the only things
inserting here are a backfill and an occasional ingest.

At query time the vector search sets `hnsw.ef_search = 100` and
`hnsw.iterative_scan = 'relaxed_order'` inside its own transaction. The second is
not tuning: without an iterative scan, a filtered search on a shared table returns
the global nearest neighbours and then discards the ones belonging to other
workspaces, so a small tenant can get an empty result while its own perfectly
good chunks sit unvisited.

### Prisma and the vector type

Prisma 7 has no native vector type, so the column is declared:

```prisma
embedding Unsupported("vector(384)")?
```

An `Unsupported` column can be neither selected nor filtered through the client,
which is why `lib/ai/retrieval.ts` and `lib/ai/embeddings.ts` reach it through raw
SQL. It is left out of the default selection set, so every existing query,
including ingest's `createMany`, keeps working untouched. `prisma generate` and
`prisma migrate deploy` are unaffected.

One caveat for local development: `prisma migrate dev` builds a shadow database,
and the shadow database needs the vector extension installed or it cannot replay
this migration. `prisma migrate deploy`, which is what `vercel-build` runs, uses
no shadow database and is unaffected.

Raw queries here schema-qualify their tables from `DATABASE_SCHEMA`, because
Prisma's pg adapter hands the schema name to the query engine rather than setting
the connection's search path. They also pass vectors as untyped parameters with
no `::vector` cast, so Postgres infers the type from the operator or the
assignment and the query works wherever the extension is installed.

## Backfilling existing chunks

The column is nullable so that deploying costs nothing and no existing row has to
be touched. Filling it in is a separate, resumable step.

```bash
# Everything still null, oldest first.
npx tsx --env-file=.env supabase/scripts/backfill-embeddings.ts

# Or a bounded first run, to watch it work.
npx tsx --env-file=.env supabase/scripts/backfill-embeddings.ts --limit 500
```

It selects only chunks whose embedding is null, in batches of 32, embeds each
batch through the Edge Function and writes the vectors in one transaction per
batch. Stopping it loses at most the batch in flight. Running it again does no
repeated work. Running it before the Edge Function is deployed fails immediately
with a message rather than half filling the table.

Progress, at any time:

```sql
SELECT count(*) FILTER (WHERE embedding IS NULL) AS pending,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
FROM "openreply"."KnowledgeChunk";
```

Retrieval works throughout. A partially backfilled table simply has fewer
chunks the vector stage can reach, and the ones it cannot reach still compete on
BM25.

## Keeping new chunks embedded

New passages need a vector at ingest, or they will only ever be found lexically.
The hook is one call in `lib/knowledge/ingest.ts`, in `commitChunks`, immediately
after the transaction that writes the chunks and marks the source READY:

```ts
await embedChunksForSource(sourceId);
```

`embedChunksForSource` never throws. A source that was crawled, chunked and
stored is usable through BM25 whether or not the embedder was reachable in that
minute, so failing an ingest over an optional recall improvement would be the
wrong trade. It logs, leaves the rows null, and the backfill picks them up later.
