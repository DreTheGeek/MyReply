-- Retention.
--
-- Nothing pruned anything. DmLog, WebhookEvent, LinkClick and OperationalEvent
-- grew forever, and an abandoned free workspace kept paying rent in storage
-- indefinitely. The privacy policy already has a "Retention and Deletion"
-- section describing behaviour the code did not implement.
--
-- THE WINDOWS, AND WHY.
--
--   DmLog            90 days. This is the delivery ledger, the most useful
--                    thing in the product, and export is uncapped by time, so
--                    anyone who wants it forever can take it. 90 days is three
--                    times what ReplyRush gives free and matches Sentry's and
--                    Dub's norms.
--   LinkClick        90 days, to stay consistent with the analytics DmLog
--                    backs. Aggregate counts on TrackedLink are not touched.
--   WebhookEvent     30 days. Raw Meta payloads: the largest rows and the
--                    least useful after the fact, since anything actionable
--                    has already become a DmLog row.
--   OperationalEvent 90 days, and only rows that are RESOLVED. An unresolved
--                    event is an open problem and deleting it would hide it.
--   ProcessedComment 90 days, well past any window a comment can be replied in.
--   Session          past expiry. NextAuth never deletes these.
--   VerificationToken past expiry. Every unused magic link accumulates.
--   OAuth codes      past expiry. Single-use already, but rows persist.
--   OAuth tokens     expired refresh tokens only; live grants stay.
--
-- FollowerSnapshot is deliberately NOT pruned. It is the one dataset Instagram
-- will not give back, one small row per account per day, and it is what makes
-- the client report worth reading.
--
-- Runs in Supabase, like every other scheduled thing here. Deleting in batches
-- with a bounded statement so a large backlog cannot hold locks for minutes.

CREATE OR REPLACE FUNCTION myreply_cron.prune(
  p_dm_days       integer DEFAULT 90,
  p_webhook_days  integer DEFAULT 30,
  p_event_days    integer DEFAULT 90,
  p_batch         integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $prune$
DECLARE
  v_schema  text := current_setting('myreply.app_schema', true);
  v_deleted jsonb := '{}'::jsonb;
  v_count   bigint;
BEGIN
  -- The application schema is not hardcoded, because DATABASE_SCHEMA decides
  -- it and a self-hoster may not use "openreply".
  IF v_schema IS NULL OR v_schema = '' THEN
    v_schema := 'openreply';
  END IF;

  EXECUTE format(
    'DELETE FROM %I."DmLog" WHERE ctid IN (
       SELECT ctid FROM %I."DmLog" WHERE "createdAt" < now() - make_interval(days => $1) LIMIT $2)',
    v_schema, v_schema) USING p_dm_days, p_batch;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('DmLog', v_count);

  EXECUTE format(
    'DELETE FROM %I."LinkClick" WHERE ctid IN (
       SELECT ctid FROM %I."LinkClick" WHERE "createdAt" < now() - make_interval(days => $1) LIMIT $2)',
    v_schema, v_schema) USING p_dm_days, p_batch;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('LinkClick', v_count);

  EXECUTE format(
    'DELETE FROM %I."WebhookEvent" WHERE ctid IN (
       SELECT ctid FROM %I."WebhookEvent" WHERE "createdAt" < now() - make_interval(days => $1) LIMIT $2)',
    v_schema, v_schema) USING p_webhook_days, p_batch;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('WebhookEvent', v_count);

  -- Resolved only. An unresolved event is an open problem.
  EXECUTE format(
    'DELETE FROM %I."OperationalEvent" WHERE ctid IN (
       SELECT ctid FROM %I."OperationalEvent"
        WHERE "createdAt" < now() - make_interval(days => $1)
          AND "resolvedAt" IS NOT NULL LIMIT $2)',
    v_schema, v_schema) USING p_event_days, p_batch;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('OperationalEvent', v_count);

  EXECUTE format(
    'DELETE FROM %I."ProcessedComment" WHERE ctid IN (
       SELECT ctid FROM %I."ProcessedComment" WHERE "seenAt" < now() - make_interval(days => $1) LIMIT $2)',
    v_schema, v_schema) USING p_event_days, p_batch;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('ProcessedComment', v_count);

  -- Expiry-driven, not age-driven: these carry their own deadline.
  EXECUTE format('DELETE FROM %I."Session" WHERE expires < now()', v_schema);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('Session', v_count);

  EXECUTE format('DELETE FROM %I."VerificationToken" WHERE expires < now()', v_schema);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('VerificationToken', v_count);

  EXECUTE format('DELETE FROM %I."OAuthAuthorizationCode" WHERE "expiresAt" < now()', v_schema);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('OAuthAuthorizationCode', v_count);

  EXECUTE format('DELETE FROM %I."OAuthToken" WHERE "expiresAt" IS NOT NULL AND "expiresAt" < now()', v_schema);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('OAuthToken', v_count);

  -- One row per run, so "did retention actually run, and what did it remove"
  -- is answerable without reading the logs.
  INSERT INTO myreply_cron.http_request
    (request_id, job_name, path, status_code, settled_at, body_excerpt)
  VALUES
    ((extract(epoch from clock_timestamp()) * 1000)::bigint,
     'myreply_prune', 'internal:prune', 200, now(), left(v_deleted::text, 500));

  RETURN v_deleted;
END;
$prune$;

COMMENT ON FUNCTION myreply_cron.prune(integer, integer, integer, integer) IS
  'Deletes aged rows from the growing tables. Batched so a backlog cannot hold locks. FollowerSnapshot is deliberately exempt.';

-- Nightly, well away from the other jobs.
DO $unschedule$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'myreply_prune') THEN
    PERFORM cron.unschedule('myreply_prune');
  END IF;
END;
$unschedule$;

SELECT cron.schedule(
  'myreply_prune',
  '30 3 * * *',
  $job$SELECT myreply_cron.prune()$job$
);
