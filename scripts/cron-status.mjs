/**
 * Prints the health of every MyReply pg_cron job.
 *
 *   node --env-file=.env scripts/cron-status.mjs
 *
 * Reads myreply_cron.job_status, the view created by the
 * 20260905000000_supabase_pg_cron_jobs migration. Connects with DIRECT_URL so
 * it works whether or not the transaction pooler is healthy.
 *
 * Nothing here writes. It is safe to run against production.
 */
import pg from "pg";

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "DIRECT_URL or DATABASE_URL must be set. Try: node --env-file=.env scripts/cron-status.mjs"
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const { rows } = await client.query(`
    select jobname,
           schedule,
           active,
           health,
           last_started_at,
           last_http_status,
           coalesce(cron_message, last_http_error) as message,
           last_http_body
      from myreply_cron.job_status
     order by jobname
  `);

  if (rows.length === 0) {
    console.log(
      "No MyReply jobs are scheduled. The migration has not been applied to this database."
    );
  } else {
    console.table(
      rows.map((r) => ({
        job: r.jobname,
        schedule: r.schedule,
        active: r.active,
        health: r.health,
        last_run_utc: r.last_started_at
          ? new Date(r.last_started_at).toISOString()
          : null,
        http: r.last_http_status,
      }))
    );

    for (const r of rows) {
      if (r.health !== "OK" && r.health !== "PENDING" && r.health !== "NEVER_RUN") {
        console.log(`\n${r.jobname} is ${r.health}`);
        if (r.message) console.log(`  ${r.message}`);
        if (r.last_http_body) console.log(`  body: ${r.last_http_body}`);
      }
    }
  }

  const unhealthy = rows.filter(
    (r) => r.health === "CRON_FAILED" || r.health === "HTTP_ERROR" || r.health === "TIMED_OUT"
  );
  process.exitCode = unhealthy.length > 0 ? 1 : 0;
} finally {
  await client.end();
}
