/**
 * The Postgres schema the app's tables live in.
 *
 * Prisma's pg adapter hands the schema name to the query engine, which
 * qualifies the SQL it generates itself. It does not set the connection's
 * search_path, so a raw query has to qualify its own tables or it will look in
 * whatever the role's default path is and find nothing. The name is validated
 * because it reaches SQL as an identifier rather than as a bound parameter.
 *
 * This used to live in lib/ai/embeddings.ts, which was the first place that
 * needed it. It is a database concern rather than an AI one, and a route that
 * wants a raw count should not have to import the embedding client to get it.
 */
export function appSchema(): string {
  const schema = process.env.DATABASE_SCHEMA ?? "public";
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) {
    throw new Error("DATABASE_SCHEMA is not a valid Postgres identifier");
  }
  return schema;
}

/** A schema-qualified, quoted table name for a raw query. */
export function qualified(table: string): string {
  return `"${appSchema()}"."${table}"`;
}
