-- CreateEnum
CREATE TYPE "KnowledgeSourceKind" AS ENUM ('WEBSITE', 'DOCUMENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AnswerVerdict" AS ENUM ('GOOD', 'WRONG');

-- CreateEnum
CREATE TYPE "WorkspacePlan" AS ENUM ('FREE', 'PRO');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "plan" "WorkspacePlan" NOT NULL DEFAULT 'FREE';

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "KnowledgeSourceKind" NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "crawlDepth" INTEGER NOT NULL DEFAULT 1,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "syncEveryHours" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "citation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantAnswer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT,
    "contactId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "handedOff" BOOLEAN NOT NULL DEFAULT false,
    "verdict" "AnswerVerdict",
    "correction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeSource_workspaceId_idx" ON "KnowledgeSource"("workspaceId");

-- CreateIndex
CREATE INDEX "KnowledgeSource_status_idx" ON "KnowledgeSource"("status");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_sourceId_idx" ON "KnowledgeChunk"("sourceId");

-- CreateIndex
CREATE INDEX "AssistantAnswer_workspaceId_createdAt_idx" ON "AssistantAnswer"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantAnswer_workspaceId_verdict_idx" ON "AssistantAnswer"("workspaceId", "verdict");

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantAnswer" ADD CONSTRAINT "AssistantAnswer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantAnswer" ADD CONSTRAINT "AssistantAnswer_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
