-- CreateEnum
CREATE TYPE "OutboundMessageSource" AS ENUM ('AUTOMATION', 'MANUAL');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "reactionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastReactionAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "contactId" TEXT,
    "recipientId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" "OutboundMessageSource" NOT NULL DEFAULT 'MANUAL',
    "dmLogId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_messageId_key" ON "OutboundMessage"("messageId");

-- CreateIndex
CREATE INDEX "OutboundMessage_workspaceId_idx" ON "OutboundMessage"("workspaceId");

-- CreateIndex
CREATE INDEX "OutboundMessage_instagramAccountId_idx" ON "OutboundMessage"("instagramAccountId");

-- CreateIndex
CREATE INDEX "OutboundMessage_contactId_idx" ON "OutboundMessage"("contactId");

-- CreateIndex
CREATE INDEX "OutboundMessage_dmLogId_idx" ON "OutboundMessage"("dmLogId");

-- CreateIndex
CREATE INDEX "OutboundMessage_instagramAccountId_recipientId_sentAt_idx" ON "OutboundMessage"("instagramAccountId", "recipientId", "sentAt");

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_dmLogId_fkey" FOREIGN KEY ("dmLogId") REFERENCES "DmLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
