-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "defaultReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liveCommentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "referralRef" TEXT,
ADD COLUMN     "storyMentionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "storyReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
