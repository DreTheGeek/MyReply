-- Usage per workspace, day, platform and kind: messages sent, public
-- replies, and model-written replies with their cost. What a partner bills
-- its own users from.
CREATE TYPE "UsageKind" AS ENUM ('MESSAGE_SENT', 'PUBLIC_REPLY', 'AI_REPLY');

CREATE TABLE "UsageDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "platform" "ChannelPlatform" NOT NULL,
    "kind" "UsageKind" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "platformFeeMicros" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageDaily_workspaceId_day_platform_kind_key" ON "UsageDaily"("workspaceId", "day", "platform", "kind");
CREATE INDEX "UsageDaily_workspaceId_day_idx" ON "UsageDaily"("workspaceId", "day");

ALTER TABLE "UsageDaily" ADD CONSTRAINT "UsageDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
