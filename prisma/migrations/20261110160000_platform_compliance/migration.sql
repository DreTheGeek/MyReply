-- Meta's deauthorize and data deletion callbacks, and retention for the
-- engine's newer tables.
--
-- InstagramAccount.authorizedByExternalId is the app-scoped id of the person
-- who granted the connection: the id Meta names when they remove the app.
--
-- DataDeletionRequest backs the confirmation code Meta shows that person and
-- the status page it links to. Their id is kept only as a hash.

ALTER TABLE "InstagramAccount" ADD COLUMN "authorizedByExternalId" TEXT;
CREATE INDEX "InstagramAccount_platform_authorizedByExternalId_idx" ON "InstagramAccount"("platform", "authorizedByExternalId");

CREATE TABLE "DataDeletionRequest" (
    "id" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "platform" "ChannelPlatform" NOT NULL,
    "userIdHash" TEXT NOT NULL,
    "accountsDeleted" INTEGER NOT NULL DEFAULT 0,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DataDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DataDeletionRequest_confirmationCode_key" ON "DataDeletionRequest"("confirmationCode");
CREATE INDEX "DataDeletionRequest_requestedAt_idx" ON "DataDeletionRequest"("requestedAt");

-- Retention for tables added after myreply_cron.prune was written. A separate
-- function, so the original is not rewritten from a copy:
--
--   CapturePrompt        30 days. A tap only counts within 7 days of the ask,
--                        and what a person agreed to lives on ContactConsent.
--   PostbackDelivery     90 days. A delivery claim only matters while Meta
--                        can still redeliver the tap.
--   DataDeletionRequest  365 days, so a confirmation code keeps resolving.
--
-- Guarded, because pg_cron exists only on the hosted database: a local or
-- self-hosted database without it still migrates.
DO $engine_prune$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'myreply_cron') THEN
    RAISE NOTICE 'myreply_cron schema not present; engine retention not scheduled';
    RETURN;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION myreply_cron.prune_engine(p_batch integer DEFAULT 5000)
    RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $body$
    DECLARE
      v_schema  text := current_setting('myreply.app_schema', true);
      v_deleted jsonb := '{}'::jsonb;
      v_count   bigint;
    BEGIN
      IF v_schema IS NULL OR v_schema = '' THEN
        v_schema := 'openreply';
      END IF;

      EXECUTE format(
        'DELETE FROM %I."CapturePrompt" WHERE ctid IN (
           SELECT ctid FROM %I."CapturePrompt" WHERE "sentAt" < now() - interval ''30 days'' LIMIT $1)',
        v_schema, v_schema) USING p_batch;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_deleted := v_deleted || jsonb_build_object('CapturePrompt', v_count);

      EXECUTE format(
        'DELETE FROM %I."PostbackDelivery" WHERE ctid IN (
           SELECT ctid FROM %I."PostbackDelivery" WHERE "createdAt" < now() - interval ''90 days'' LIMIT $1)',
        v_schema, v_schema) USING p_batch;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_deleted := v_deleted || jsonb_build_object('PostbackDelivery', v_count);

      EXECUTE format(
        'DELETE FROM %I."DataDeletionRequest" WHERE ctid IN (
           SELECT ctid FROM %I."DataDeletionRequest" WHERE "requestedAt" < now() - interval ''365 days'' LIMIT $1)',
        v_schema, v_schema) USING p_batch;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_deleted := v_deleted || jsonb_build_object('DataDeletionRequest', v_count);

      INSERT INTO myreply_cron.http_request
        (request_id, job_name, path, status_code, settled_at, body_excerpt)
      VALUES
        ((extract(epoch from clock_timestamp()) * 1000)::bigint,
         'myreply_prune_engine', 'internal:prune_engine', 200, now(), left(v_deleted::text, 500));

      RETURN v_deleted;
    END;
    $body$;
  $fn$;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'myreply_prune_engine') THEN
      PERFORM cron.unschedule('myreply_prune_engine');
    END IF;
    PERFORM cron.schedule(
      'myreply_prune_engine',
      '45 3 * * *',
      'SELECT myreply_cron.prune_engine()'
    );
  END IF;
END;
$engine_prune$;
