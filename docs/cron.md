# Scheduled jobs

Supabase owns scheduling. Vercel only serves the app.

Every recurring job in MyReply is a row in `cron.job` on the Supabase database.
pg_cron fires on the schedule, pg_net makes an HTTP call back into the normal
Next.js API route, and the route does the work exactly as it always has. There
is no job logic in the database, and there are no Vercel crons any more.

If you have forgotten everything else, the one command worth remembering is:

```bash
node --env-file=.env scripts/cron-status.mjs
```

---

## What runs, and when

All times are UTC. See [Time zones](#time-zones) below.

| Job name | Schedule (UTC) | Calls | What it does |
| --- | --- | --- | --- |
| `myreply_refresh_tokens` | `0 5 * * *` | `GET /api/cron/refresh-tokens` | Refreshes Instagram long lived tokens that expire within 10 days, and rolls monthly usage counters. |
| `myreply_attach_next_reel` | `0 6 * * *` | `GET /api/cron/attach-next-reel` | Binds campaigns waiting on "my next reel" to the reel that was actually posted. |
| `myreply_snapshot_followers` | `0 7 * * *` | `GET /api/cron/snapshot-followers` | Records one follower total per connected account per day. A missed run loses that day permanently. |
| `myreply_ingest_knowledge` | `*/15 * * * *` | `GET /api/cron/ingest-knowledge` | Retries abandoned knowledge ingests and re-crawls sources that came due. |
| `myreply_settle_responses` | `*/5 * * * *` | nothing, runs in the database | Copies pg_net HTTP responses onto the request log before pg_net drops them. This is what makes the other four observable. |

## Where it is defined

`prisma/migrations/20260905000000_supabase_pg_cron_jobs/migration.sql`

That one file creates everything: the `myreply_cron` schema, the request log,
the two functions, the status view, and the five `cron.schedule` calls. It is
idempotent. It unschedules each job by name before scheduling it, so applying
it twice replaces the jobs instead of duplicating them.

It lives in a schema of its own, `myreply_cron`, rather than in the application
schema named by `DATABASE_SCHEMA`. Prisma does not model these tables, and
keeping them out of the tracked schema stops `prisma migrate dev` from
reporting them as drift.

## The two secrets

The jobs need to know where the app is and how to authenticate to it. Neither
value is in the migration and neither is in `cron.job.command`, because
`cron.job.command` is plain text readable by anyone who can reach the database.
Both live in `supabase_vault` and are read at run time.

| Vault secret name | Value |
| --- | --- |
| `myreply_app_url` | The deployed origin with no trailing path, for example `https://app.myreply.com`. |
| `myreply_cron_secret` | Exactly the value of `CRON_SECRET` in the app environment. If `CRON_SECRET` is unset the routes fall back to `NEXTAUTH_SECRET`, so use that instead. |

Create them once, on a session connection (`DIRECT_URL`, port 5432), in the
Supabase SQL editor or psql. Never in a migration, and never in a file that
lands in git:

```sql
select vault.create_secret(
  'https://app.myreply.com',
  'myreply_app_url',
  'Origin that MyReply pg_cron jobs call back into.'
);

select vault.create_secret(
  'the-real-cron-secret',
  'myreply_cron_secret',
  'Bearer token for MyReply cron routes. Mirrors CRON_SECRET in the app env.'
);
```

Until both exist, every run fails with a clear message in
`cron.job_run_details.return_message` and the status view reports `CRON_FAILED`.
That is deliberate. A cron that quietly does nothing is worse than one that
fails loudly.

## Rotating the secret

Rotation is an `UPDATE`, not a migration or a redeploy of the job definitions.
Order matters, because the app compares what it receives against its own env:

1. Set the new `CRON_SECRET` in the Vercel project environment and redeploy.
2. Update the vault secret to match:

   ```sql
   select vault.update_secret(
     (select id from vault.secrets where name = 'myreply_cron_secret'),
     'the-new-cron-secret'
   );
   ```

3. Wait for the next `myreply_ingest_knowledge` tick, at most 15 minutes, then
   run `scripts/cron-status.mjs`. A stale secret shows as
   `health = HTTP_ERROR` with `last_http_status = 401`.

Moving the app to a new domain is the same shape, against `myreply_app_url`.

## Did the job actually succeed?

This is the question the whole setup is built around, so read this part.

pg_net is asynchronous. `net.http_get` returns a request id immediately and the
job finishes right there. `cron.job_run_details.status = 'succeeded'` therefore
means only "the database queued an HTTP request", not "the app did the work".
A route that returned 500, or 401, or never answered, looks identical in
`cron.job_run_details` to one that returned 200.

The real answer arrives later in `net._http_response`, and pg_net deletes those
rows once `pg_net.ttl` passes, which is six hours on this project. A daily job's
response is gone long before anyone looks. So `myreply_settle_responses` runs
every five minutes and copies the outcome onto `myreply_cron.http_request`,
where it is kept for 30 days.

### The quick way

```bash
node --env-file=.env scripts/cron-status.mjs
```

It exits non-zero if any job is `CRON_FAILED`, `HTTP_ERROR`, or `TIMED_OUT`, so
it also works as a health check in a shell.

### The SQL

```sql
select jobname,
       schedule,
       active,
       health,
       last_started_at,
       last_http_status,
       coalesce(cron_message, last_http_error) as message,
       last_http_body
  from myreply_cron.job_status
 order by jobname;
```

`health` is the column to read:

| health | Meaning |
| --- | --- |
| `OK` | The job ran and the route answered 2xx. |
| `PENDING` | The request is in flight, or the settler has not caught up yet. Normal for up to five minutes. |
| `HTTP_ERROR` | The route answered, and it was not 2xx. Check `last_http_status` and `last_http_body`. A 401 means the secret does not match. |
| `TIMED_OUT` | The route did not answer inside the client timeout. |
| `CRON_FAILED` | The job body itself raised, usually a missing vault secret. Read `cron_message`. |
| `NO_HTTP_CALL` | pg_cron ran the job but no request was ever logged. Something is wrong with the plumbing itself. |
| `PAUSED` | Someone deactivated the job. See below. |
| `NEVER_RUN` | Freshly scheduled and not yet due. |

### Digging into one job

```sql
select requested_at, status_code, timed_out, error_msg, body_excerpt
  from myreply_cron.http_request
 where job_name = 'myreply_snapshot_followers'
 order by requested_at desc
 limit 20;
```

Raw pg_cron history, including runs that never got as far as an HTTP call:

```sql
select d.start_time, d.status, d.return_message
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where j.jobname = 'myreply_snapshot_followers'
 order by d.start_time desc
 limit 20;
```

### Note on the admin diagnostics route

`/api/admin/diagnostics` was not extended with this, because that route was
outside the set of files this change was allowed to touch. The SQL above is
what to paste in when someone wants it there. It needs no extra grants: the app
connects as `postgres`, which owns the view.

## Changing a schedule

Two ways, and they disagree with each other if you are careless.

**The right way** is to edit the `cron.schedule` call in the migration and
apply the change as a new migration, so the repository stays the source of
truth. Copy the whole `SELECT cron.schedule(...)` statement into a new
migration file with the new cron expression. Because scheduling by an existing
name replaces the job in place, no unschedule is needed.

**The quick way**, for an incident, is a direct `cron.alter_job`:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'myreply_ingest_knowledge'),
  schedule => '*/30 * * * *'
);
```

If you do that, write it back into a migration afterwards or the next apply of
the checked in schedule will silently undo it.

Cron expressions are standard five field `minute hour day-of-month month
day-of-week`.

## Pausing a job

Pause, so the definition survives:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'myreply_attach_next_reel'),
  active => false
);
```

Resume:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'myreply_attach_next_reel'),
  active => true
);
```

A paused job shows as `health = PAUSED` in the status view, so a pause someone
forgot about is visible rather than silent.

To remove a job entirely, `select cron.unschedule('myreply_attach_next_reel');`
and delete its `cron.schedule` call from the migration in the same change.
Otherwise the next apply brings it back.

## Running a job right now

```sql
select myreply_cron.invoke(
  'myreply_snapshot_followers',
  '/api/cron/snapshot-followers',
  120000
);
```

That fires the same HTTP call the schedule fires, logs it the same way, and the
result shows up in `myreply_cron.job_status` within five minutes. Note that
this is against the live app, so it does live work.

## Time zones

pg_cron on this project schedules in UTC. `cron.timezone` is `GMT` and the
server `TimeZone` is `UTC`, which is what Vercel Cron used too. The four
schedules were carried over unchanged and still mean the same wall clock
moments they meant before.

Everything the view reports is UTC as well, including `last_started_at`.

## Why HTTP and not a database function

The four routes need `decryptToken` from `lib/meta/oauth.ts`, which is AES-GCM
against `ENCRYPTION_KEY`, and two of them need Node only document parsers.
Reimplementing that crypto in plpgsql or in a Deno edge function would fork it
into a second runtime, and getting it subtly wrong would make every stored
Instagram token unreadable. Calling the existing route keeps exactly one
implementation.

The jobs use `net.http_get`, not `net.http_post`, because all four routes export
`GET` only, which is what Vercel Cron issued. A POST would come back 405.

## Ordering, when deploying this

Apply the migration before the deploy that removes `crons` from `vercel.json`.
Vercel stops firing the old crons on the next deploy, so if the deploy lands
first there is a window with no scheduler at all. Running both for a short
overlap is harmless: the routes are idempotent, and a double run of any of them
is a wasted call, not a corrupt record.
