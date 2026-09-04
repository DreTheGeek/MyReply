-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "quickRepliesEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "quickReplies" JSONB;
