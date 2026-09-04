-- Scheduled work moves from Vercel Cron to Supabase pg_cron.
--
-- Supabase owns scheduling from here on. Vercel only serves the app. Each job
-- calls the existing Next.js route over HTTP with the same bearer token Vercel
-- Cron sent, so no job logic is duplicated in the database. The routes need
-- decryptToken from lib/meta/oauth.ts and, for knowledge ingest, Node only
-- document parsers, so rewriting them as database or Deno functions would fork
-- the token crypto into a second runtime.
--
-- Two decisions worth knowing before you edit this file.
--
-- 1. The jobs use net.http_get, not net.http_post. All four routes export GET
--    only, which is what Vercel Cron issued. A POST would come back 405.
-- 2. Neither the app origin nor the cron secret appears in this file or in
--    cron.job.command. cron.job.command is readable by anyone who can reach
--    the database, so both values live in supabase_vault and are read at run
--    time. Rotating either is an UPDATE, not a migration.
--
-- Before the jobs can do anything, these two vault secrets must exist:
--   myreply_app_url      deployed origin, for example https://app.myreply.com
--   myreply_cron_secret  the value of CRON_SECRET in the app environment
-- Until then every run fails loudly with the missing name in
-- cron.job_run_details.return_message. docs/cron.md has the exact statements.
--
-- Everything below is idempotent. Applying it twice replaces the jobs rather
-- than duplicating them.

-- Cron plumbing lives in its own schema, not the application schema named by
-- DATABASE_SCHEMA. Prisma does not model these tables, and keeping them out of
-- the tracked schema stops prisma migrate dev from reporting them as drift.
CREATE SCHEMA IF NOT EXISTS myreply_cron;

COMMENT ON SCHEMA myreply_cron IS
  'pg_cron plumbing for MyReply scheduled jobs. Not modelled by Prisma.';

-- pg_net is asynchronous. net.http_get returns a request id immediately and
-- the response lands in net._http_response later, then disappears once
-- pg_net.ttl passes (six hours on this project). A job that gets a 500 looks
-- exactly like one that got a 200 unless something records the outcome. This
-- table is that record, and it outlives the pg_net ttl.
CREATE TABLE IF NOT EXISTS myreply_cron.http_request (
  request_id   bigint PRIMARY KEY,
  job_name     text NOT NULL,
  path         text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status_code  integer,
  timed_out    boolean,
  error_msg    text,
  body_excerpt text,
  settled_at   timestamptz
);

COMMENT ON TABLE myreply_cron.http_request IS
  'One row per outbound cron HTTP call. settled_at is null until myreply_cron.settle copies the pg_net response in.';

CREATE INDEX IF NOT EXISTS http_request_job_name_requested_at_idx
  ON myreply_cron.http_request (job_name, requested_at DESC);

CREATE INDEX IF NOT EXISTS http_request_open_idx
  ON myreply_cron.http_request (requested_at)
  WHERE settled_at IS NULL;

-- The table is owned by the migrating role, which bypasses RLS, and the schema
-- is not exposed through PostgREST. RLS with no policy is belt and braces: if
-- this schema is ever exposed, it denies by default rather than leaking run
-- history.
ALTER TABLE myreply_cron.http_request ENABLE ROW LEVEL SECURITY;

-- Fires one job. Reads the origin and the bearer token from the vault, calls
-- the route, and records the pg_net request id so the response can be matched
-- back to the job later.
--
-- SECURITY INVOKER on purpose. pg_cron runs the job as the role that scheduled
-- it, which already reads the vault. A definer function here would hand vault
-- reads to anyone who could call it.
CREATE OR REPLACE FUNCTION myreply_cron.invoke(
  p_job_name text,
  p_path text,
  p_timeout_ms integer DEFAULT 120000
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $invoke$
DECLARE
  v_origin  text;
  v_secret  text;
  v_url     text;
  v_request bigint;
BEGIN
  SELECT s.decrypted_secret INTO v_origin
    FROM vault.decrypted_secrets s
   WHERE s.name = 'myreply_app_url';

  SELECT s.decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets s
   WHERE s.name = 'myreply_cron_secret';

  IF v_origin IS NULL OR btrim(v_origin) = '' THEN
    RAISE EXCEPTION
      'vault secret myreply_app_url is missing or empty. See docs/cron.md.';
  END IF;

  IF v_secret IS NULL OR btrim(v_secret) = '' THEN
    RAISE EXCEPTION
      'vault secret myreply_cron_secret is missing or empty. See docs/cron.md.';
  END IF;

  v_url := rtrim(btrim(v_origin), '/') || p_path;

  SELECT net.http_get(
           url := v_url,
           headers := jsonb_build_object(
             'Authorization', 'Bearer ' || btrim(v_secret),
             'User-Agent', 'myreply-pg-cron/1'
           ),
           timeout_milliseconds := p_timeout_ms
         )
    INTO v_request;

  INSERT INTO myreply_cron.http_request (request_id, job_name, path)
  VALUES (v_request, p_job_name, p_path);

  RETURN v_request;
END;
$invoke$;

COMMENT ON FUNCTION myreply_cron.invoke(text, text, integer) IS
  'Calls a MyReply cron route with the vault held bearer token and logs the pg_net request id.';

-- Copies pg_net responses onto the request rows before pg_net.ttl deletes
-- them, closes out requests whose response never arrived, and trims history.
CREATE OR REPLACE FUNCTION myreply_cron.settle(p_retain_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $settle$
DECLARE
  v_settled integer;
BEGIN
  UPDATE myreply_cron.http_request r
     SET status_code  = resp.status_code,
         timed_out    = resp.timed_out,
         error_msg    = resp.error_msg,
         body_excerpt = left(resp.content, 500),
         settled_at   = now()
    FROM net._http_response resp
   WHERE resp.id = r.request_id
     AND r.settled_at IS NULL;

  GET DIAGNOSTICS v_settled = ROW_COUNT;

  -- The longest job timeout is five minutes. Anything still open an hour later
  -- lost its response row, so close it rather than leave it pending forever.
  UPDATE myreply_cron.http_request
     SET settled_at = now(),
         error_msg  = 'no pg_net response found. It expired or the pg_net worker dropped the request.'
   WHERE settled_at IS NULL
     AND requested_at < now() - interval '1 hour';

  DELETE FROM myreply_cron.http_request
   WHERE requested_at < now() - make_interval(days => p_retain_days);

  RETURN v_settled;
END;
$settle$;

COMMENT ON FUNCTION myreply_cron.settle(integer) IS
  'Matches net._http_response rows onto myreply_cron.http_request before the pg_net ttl drops them.';

-- One row per MyReply job: when it last ran, what pg_cron thought of the run,
-- and what the app actually answered. health is the column to read.
CREATE OR REPLACE VIEW myreply_cron.job_status
WITH (security_invoker = true) AS
WITH last_run AS (
  SELECT DISTINCT ON (d.jobid)
         d.jobid,
         d.status,
         d.return_message,
         d.start_time,
         d.end_time
    FROM cron.job_run_details d
   ORDER BY d.jobid, d.start_time DESC
),
last_call AS (
  SELECT DISTINCT ON (r.job_name)
         r.job_name,
         r.request_id,
         r.requested_at,
         r.status_code,
         r.timed_out,
         r.error_msg,
         r.body_excerpt,
         r.settled_at
    FROM myreply_cron.http_request r
   ORDER BY r.job_name, r.requested_at DESC
)
SELECT
  j.jobid,
  j.jobname,
  j.schedule,
  j.active,
  lr.start_time      AS last_started_at,
  lr.end_time        AS last_finished_at,
  lr.status          AS cron_status,
  lr.return_message  AS cron_message,
  lc.request_id      AS last_request_id,
  lc.requested_at    AS last_requested_at,
  lc.status_code     AS last_http_status,
  lc.timed_out       AS last_http_timed_out,
  lc.error_msg       AS last_http_error,
  lc.body_excerpt    AS last_http_body,
  CASE
    WHEN NOT j.active THEN 'PAUSED'
    WHEN lr.jobid IS NULL THEN 'NEVER_RUN'
    WHEN lr.status NOT IN ('succeeded', 'running') THEN 'CRON_FAILED'
    WHEN j.command NOT LIKE '%myreply_cron.invoke%' THEN 'OK'
    WHEN lc.job_name IS NULL THEN 'NO_HTTP_CALL'
    WHEN lc.settled_at IS NULL THEN 'PENDING'
    WHEN lc.timed_out THEN 'TIMED_OUT'
    WHEN lc.status_code BETWEEN 200 AND 299 THEN 'OK'
    ELSE 'HTTP_ERROR'
  END AS health
  FROM cron.job j
  LEFT JOIN last_run  lr ON lr.jobid = j.jobid
  LEFT JOIN last_call lc ON lc.job_name = j.jobname
 WHERE j.jobname LIKE 'myreply\_%';

COMMENT ON VIEW myreply_cron.job_status IS
  'Last run and last HTTP result for every MyReply pg_cron job. Read the health column first.';

-- Unschedule by name before scheduling, so a second apply replaces rather than
-- duplicates. cron.unschedule raises if the name is unknown, hence the guard.
DO $unschedule$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'myreply_refresh_tokens',
    'myreply_attach_next_reel',
    'myreply_snapshot_followers',
    'myreply_ingest_knowledge',
    'myreply_settle_responses'
  ] LOOP
    IF EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = v_name) THEN
      PERFORM cron.unschedule(v_name);
    END IF;
  END LOOP;
END;
$unschedule$;

-- Schedules are UTC. cron.timezone on this project is GMT and the server
-- TimeZone is UTC, which is also what Vercel Cron used, so these five field
-- expressions mean exactly what they meant in vercel.json.

-- Refreshes Instagram long lived tokens and rolls monthly usage counters.
SELECT cron.schedule(
  'myreply_refresh_tokens',
  '0 5 * * *',
  $job$SELECT myreply_cron.invoke('myreply_refresh_tokens', '/api/cron/refresh-tokens', 120000)$job$
);

-- Binds pending next reel campaigns to the reel that was actually posted.
SELECT cron.schedule(
  'myreply_attach_next_reel',
  '0 6 * * *',
  $job$SELECT myreply_cron.invoke('myreply_attach_next_reel', '/api/cron/attach-next-reel', 120000)$job$
);

-- Records one follower total per account per day. A missed run loses that day
-- permanently, so watch this one.
SELECT cron.schedule(
  'myreply_snapshot_followers',
  '0 7 * * *',
  $job$SELECT myreply_cron.invoke('myreply_snapshot_followers', '/api/cron/snapshot-followers', 120000)$job$
);

-- Retries abandoned knowledge ingests and re-crawls sources that came due. The
-- route declares maxDuration 300, so the client timeout matches it.
SELECT cron.schedule(
  'myreply_ingest_knowledge',
  '*/15 * * * *',
  $job$SELECT myreply_cron.invoke('myreply_ingest_knowledge', '/api/cron/ingest-knowledge', 300000)$job$
);

-- Harvests pg_net responses. Must run well inside the six hour pg_net ttl.
SELECT cron.schedule(
  'myreply_settle_responses',
  '*/5 * * * *',
  $job$SELECT myreply_cron.settle()$job$
);

-- Applying the migration does not create the secrets. Say so out loud, since a
-- job with no secret fails on every tick.
DO $secrets$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets s
     WHERE s.name = 'myreply_app_url' AND btrim(coalesce(s.decrypted_secret, '')) <> ''
  ) THEN
    v_missing := v_missing || 'myreply_app_url'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets s
     WHERE s.name = 'myreply_cron_secret' AND btrim(coalesce(s.decrypted_secret, '')) <> ''
  ) THEN
    v_missing := v_missing || 'myreply_cron_secret'::text;
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE WARNING
      'MyReply cron jobs are scheduled but these vault secrets are missing: %. Every run will fail until they exist. See docs/cron.md.',
      array_to_string(v_missing, ', ');
  END IF;
END;
$secrets$;
