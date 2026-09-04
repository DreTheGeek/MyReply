/**
 * Fill in embeddings for knowledge chunks that were ingested before the vector
 * column existed.
 *
 * Deliberately a script and not a migration. The migration adds a nullable
 * column so that deploying costs nothing and no existing row has to be touched;
 * pushing a few hundred thousand rows through an HTTP service inside a
 * migration transaction would hold a lock over work the application already
 * degrades around gracefully.
 *
 * Safe to stop and safe to re-run. It only ever selects rows whose embedding is
 * still null, so interrupting it loses at most the batch in flight and running
 * it twice does no extra work.
 *
 *   npx tsx --env-file=.env supabase/scripts/backfill-embeddings.ts
 *   npx tsx --env-file=.env supabase/scripts/backfill-embeddings.ts --limit 500
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and EMBED_SHARED_SECRET, and
 * the embed function to be deployed. Prints counts and nothing else: no keys,
 * no chunk text.
 */

import { backfillChunkEmbeddings } from "@/lib/ai/embeddings";

function readLimit(argv: string[]): number | undefined {
  const index = argv.indexOf("--limit");
  if (index === -1) return undefined;

  const raw = argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--limit takes a positive whole number");
  }
  return value;
}

async function main(): Promise<void> {
  const maxChunks = readLimit(process.argv.slice(2));

  const result = await backfillChunkEmbeddings({
    maxChunks,
    onProgress: (embedded: number): void => {
      console.log(`[backfill] ${embedded} chunks embedded`);
    },
  });

  console.log(
    `[backfill] done. ${result.embedded} chunks embedded, ${result.truncated} of them longer than the model's window.`
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    // The message is the embedding layer's own, which is already free of keys
    // and of customer text.
    console.error(
      "[backfill] failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    process.exit(1);
  });
