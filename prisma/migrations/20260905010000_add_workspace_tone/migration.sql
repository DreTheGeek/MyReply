-- CreateEnum
CREATE TYPE "WorkspaceTone" AS ENUM ('FRIENDLY', 'PROFESSIONAL', 'HYPE', 'SHORT', 'WARM');

-- AlterTable
-- Additive and defaulted, so every existing workspace gets the friendly voice
-- without a backfill and nothing reads null.
ALTER TABLE "Workspace" ADD COLUMN     "tone" "WorkspaceTone" NOT NULL DEFAULT 'FRIENDLY';
