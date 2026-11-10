-- Partner apps: an app that creates and owns workspaces for its own users,
-- and acts on them with a partner key. A partner's workspace has no owner
-- signing in here, so Workspace.ownerId becomes optional.

ALTER TABLE "Workspace" ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE "Workspace" ADD COLUMN "partnerId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "externalId" TEXT;

CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#111827',
    "accentColor" TEXT NOT NULL DEFAULT '#2563EB',
    "showPoweredBy" BOOLEAN NOT NULL DEFAULT false,
    "emailFromName" TEXT,
    "emailFromAddress" TEXT,
    "customDomain" TEXT,
    "frameOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "returnOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workspacePlan" "WorkspacePlan" NOT NULL DEFAULT 'FREE',
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PartnerApiKey" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Partner_customDomain_key" ON "Partner"("customDomain");
CREATE UNIQUE INDEX "PartnerApiKey_hashedKey_key" ON "PartnerApiKey"("hashedKey");
CREATE INDEX "PartnerApiKey_partnerId_idx" ON "PartnerApiKey"("partnerId");
CREATE UNIQUE INDEX "Workspace_partnerId_externalId_key" ON "Workspace"("partnerId", "externalId");
CREATE INDEX "Workspace_partnerId_createdAt_idx" ON "Workspace"("partnerId", "createdAt");

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerApiKey" ADD CONSTRAINT "PartnerApiKey_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
