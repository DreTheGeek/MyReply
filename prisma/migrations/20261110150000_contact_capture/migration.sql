-- Collect an email or phone number, with consent recorded.
--
-- A campaign can ask for an email or phone number after its message. Each ask
-- is stored with the consent wording exactly as shown (CapturePrompt), and a
-- tap is stored against it with the time and the message it arrived as
-- (ContactConsent). The unique key on (contactId, sourceMessageId) means a
-- retried webhook never records the same tap twice.

CREATE TYPE "ContactDetailKind" AS ENUM ('EMAIL', 'PHONE');

ALTER TABLE "Contact" ADD COLUMN "email" TEXT;
ALTER TABLE "Contact" ADD COLUMN "phone" TEXT;

ALTER TABLE "Automation" ADD COLUMN "captureEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Automation" ADD COLUMN "captureKinds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Automation" ADD COLUMN "capturePrompt" TEXT;
ALTER TABLE "Automation" ADD COLUMN "captureConsentText" TEXT;

CREATE TABLE "CapturePrompt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "automationId" TEXT,
    "recipientExternalId" TEXT NOT NULL,
    "kinds" "ContactDetailKind"[],
    "consentText" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapturePrompt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactConsent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "automationId" TEXT,
    "kind" "ContactDetailKind" NOT NULL,
    "value" TEXT NOT NULL,
    "consentText" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactConsent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CapturePrompt_instagramAccountId_recipientExternalId_sentAt_idx" ON "CapturePrompt"("instagramAccountId", "recipientExternalId", "sentAt");
CREATE INDEX "CapturePrompt_sentAt_idx" ON "CapturePrompt"("sentAt");
CREATE UNIQUE INDEX "ContactConsent_contactId_sourceMessageId_key" ON "ContactConsent"("contactId", "sourceMessageId");
CREATE INDEX "ContactConsent_workspaceId_consentedAt_idx" ON "ContactConsent"("workspaceId", "consentedAt");

ALTER TABLE "CapturePrompt" ADD CONSTRAINT "CapturePrompt_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CapturePrompt" ADD CONSTRAINT "CapturePrompt_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
