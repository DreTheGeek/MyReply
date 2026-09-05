-- CreateEnum
CREATE TYPE "FlowTrigger" AS ENUM ('COMMENT', 'DM_KEYWORD', 'STORY_REPLY', 'STORY_MENTION', 'LIVE_COMMENT', 'REFERRAL', 'QUICK_REPLY', 'REACTION', 'MENTION');

-- CreateEnum
CREATE TYPE "FlowRunStatus" AS ENUM ('RUNNING', 'WAITING', 'DONE', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "FlowStepStatus" AS ENUM ('DONE', 'SKIPPED', 'FAILED', 'WAITING');

-- CreateEnum
CREATE TYPE "ConversionSource" AS ENUM ('SQUARE', 'WEBHOOK', 'MANUAL');

-- The HNSW index on KnowledgeChunk.embedding is deliberately NOT dropped.
-- Prisma proposes dropping it on every diff because the column is
-- Unsupported("vector(384)") and the index was created in raw SQL, so the
-- schema file cannot declare it. Removing it would leave every semantic
-- search doing a sequential scan over every chunk.

-- AlterTable
ALTER TABLE "LinkClick" ADD COLUMN     "clickToken" TEXT,
ADD COLUMN     "contactId" TEXT;

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" "FlowTrigger" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "definition" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowRun" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contactId" TEXT,
    "status" "FlowRunStatus" NOT NULL DEFAULT 'RUNNING',
    "resumeAt" TIMESTAMP(3),
    "cursorStepId" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FlowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowStepLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "FlowStepStatus" NOT NULL,
    "detail" JSONB,
    "errorMessage" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlowStepLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "automationId" TEXT,
    "contactId" TEXT,
    "linkClickId" TEXT,
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "source" "ConversionSource" NOT NULL,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Flow_workspaceId_idx" ON "Flow"("workspaceId");

-- CreateIndex
CREATE INDEX "Flow_workspaceId_trigger_isActive_idx" ON "Flow"("workspaceId", "trigger", "isActive");

-- CreateIndex
CREATE INDEX "FlowRun_workspaceId_startedAt_idx" ON "FlowRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "FlowRun_status_resumeAt_idx" ON "FlowRun"("status", "resumeAt");

-- CreateIndex
CREATE INDEX "FlowRun_flowId_idx" ON "FlowRun"("flowId");

-- CreateIndex
CREATE INDEX "FlowStepLog_runId_at_idx" ON "FlowStepLog"("runId", "at");

-- CreateIndex
CREATE INDEX "Conversion_workspaceId_createdAt_idx" ON "Conversion"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversion_automationId_idx" ON "Conversion"("automationId");

-- CreateIndex
CREATE INDEX "Conversion_contactId_idx" ON "Conversion"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversion_workspaceId_source_externalId_key" ON "Conversion"("workspaceId", "source", "externalId");

-- CreateIndex
CREATE INDEX "LinkClick_contactId_idx" ON "LinkClick"("contactId");

-- CreateIndex
CREATE INDEX "LinkClick_clickToken_idx" ON "LinkClick"("clickToken");

-- AddForeignKey
ALTER TABLE "LinkClick" ADD CONSTRAINT "LinkClick_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowStepLog" ADD CONSTRAINT "FlowStepLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FlowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_linkClickId_fkey" FOREIGN KEY ("linkClickId") REFERENCES "LinkClick"("id") ON DELETE SET NULL ON UPDATE CASCADE;
