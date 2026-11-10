-- Outbound webhooks to partner apps and workspaces, with a delivery log, and
-- retention for the platform layer's tables.

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "partnerId" TEXT,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[],
    "secretEncrypted" TEXT NOT NULL,
    "secretHint" TEXT NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id"),
    -- Exactly one owner: a workspace or a partner, never both, never neither.
    CONSTRAINT "WebhookEndpoint_one_owner" CHECK (("workspaceId" IS NULL) <> ("partnerId" IS NULL))
);

CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookEndpoint_workspaceId_idx" ON "WebhookEndpoint"("workspaceId");
CREATE INDEX "WebhookEndpoint_partnerId_idx" ON "WebhookEndpoint"("partnerId");
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");
CREATE INDEX "WebhookDelivery_createdAt_idx" ON "WebhookDelivery"("createdAt");

ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Retention for the platform layer, in its own function like prune_engine:
--
--   IdempotencyRecord  24 hours. A retry only matters while a client is
--                      still retrying.
--   WebhookDelivery    30 days. The delivery log a partner reads to debug.
--
-- Guarded, because pg_cron exists only on the hosted database.
DO $platform_prune$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'myreply_cron') THEN
    RAISE NOTICE 'myreply_cron schema not present; platform retention not scheduled';
    RETURN;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION myreply_cron.prune_platform(p_batch integer DEFAULT 5000)
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
        'DELETE FROM %I."IdempotencyRecord" WHERE ctid IN (
           SELECT ctid FROM %I."IdempotencyRecord" WHERE "createdAt" < now() - interval ''24 hours'' LIMIT $1)',
        v_schema, v_schema) USING p_batch;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_deleted := v_deleted || jsonb_build_object('IdempotencyRecord', v_count);

      EXECUTE format(
        'DELETE FROM %I."WebhookDelivery" WHERE ctid IN (
           SELECT ctid FROM %I."WebhookDelivery" WHERE "createdAt" < now() - interval ''30 days'' LIMIT $1)',
        v_schema, v_schema) USING p_batch;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_deleted := v_deleted || jsonb_build_object('WebhookDelivery', v_count);

      INSERT INTO myreply_cron.http_request
        (request_id, job_name, path, status_code, settled_at, body_excerpt)
      VALUES
        ((extract(epoch from clock_timestamp()) * 1000)::bigint,
         'myreply_prune_platform', 'internal:prune_platform', 200, now(), left(v_deleted::text, 500));

      RETURN v_deleted;
    END;
    $body$;
  $fn$;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'myreply_prune_platform') THEN
      PERFORM cron.unschedule('myreply_prune_platform');
    END IF;
    PERFORM cron.schedule(
      'myreply_prune_platform',
      '0 4 * * *',
      'SELECT myreply_cron.prune_platform()'
    );
  END IF;
END;
$platform_prune$;
