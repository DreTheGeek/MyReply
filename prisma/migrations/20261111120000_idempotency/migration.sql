-- Idempotency keys on v1 writes. Retention (24 hours) is in the platform
-- prune function added with outbound webhooks.
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" INTEGER,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdempotencyRecord_credentialId_key_key" ON "IdempotencyRecord"("credentialId", "key");
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
