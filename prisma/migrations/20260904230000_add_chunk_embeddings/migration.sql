-- Hybrid retrieval: a pgvector embedding on every knowledge passage.
--
-- The column is nullable and stays nullable. Every chunk already in this table
-- was ingested before embeddings existed, and all of them have to keep
-- answering customers through BM25 while the backfill runs, or while it never
-- runs at all. Nothing in the application treats a null here as an error.
--
-- WHY THIS IS WRAPPED IN A DO BLOCK
-- The vector extension is installed once per project, into whichever schema
-- that project chose. Supabase puts it in "extensions"; a self-hosted Postgres
-- usually puts it in "public". Migrations run with a search_path pointed at the
-- application schema, which is "openreply" here, and that path does not
-- necessarily include the extension's schema. Writing a bare `vector(384)`
-- would therefore work on one deployment and fail on another for a reason that
-- has nothing to do with this migration. Looking the schema up in the catalog
-- and qualifying the type is the version that is correct everywhere.

DO $$
DECLARE
  vector_schema text;
BEGIN
  SELECT n.nspname
    INTO vector_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'vector';

  IF vector_schema IS NULL THEN
    RAISE EXCEPTION
      'The vector extension is not installed. Enable it first, for example CREATE EXTENSION vector;';
  END IF;

  EXECUTE format(
    'ALTER TABLE "KnowledgeChunk" ADD COLUMN "embedding" %I.vector(384)',
    vector_schema
  );

  -- HNSW rather than IVFFlat. IVFFlat has to be built against data that is
  -- already there and its lists have to be re-tuned as the table grows, and
  -- this column starts life entirely null, so an IVFFlat index built now would
  -- be built over nothing. HNSW is built incrementally as rows are written,
  -- which is what a nullable column filled in by a background backfill needs.
  --
  -- Cosine distance because gte-small returns unit vectors under
  -- { mean_pool: true, normalize: true }, so cosine and inner product agree,
  -- and cosine keeps agreeing if a future model stops normalising.
  --
  -- m = 16 is the number of links each node keeps. Recall against 384
  -- dimensional embeddings is flat above roughly this value until the table
  -- reaches millions of rows; MyReply caps a source at 5000 chunks and a
  -- workspace has a handful of sources, so this table is four to five orders of
  -- magnitude below the point where m = 32 would start to pay for the index
  -- size and build time it costs.
  --
  -- ef_construction = 80 rather than pgvector's default of 64. It is the
  -- build-time candidate list, so it buys graph quality, and therefore recall
  -- at any given query-time ef_search, at no query cost whatsoever. The price
  -- is paid per insert, and inserts here are a backfill and an occasional
  -- ingest, neither of which anyone is waiting on. 200 was not chosen because
  -- the extra recall on a table this small is not measurable, while the per
  -- insert cost is.
  EXECUTE format(
    'CREATE INDEX "KnowledgeChunk_embedding_hnsw_idx"
       ON "KnowledgeChunk"
       USING hnsw ("embedding" %I.vector_cosine_ops)
       WITH (m = 16, ef_construction = 80)',
    vector_schema
  );
END
$$;
