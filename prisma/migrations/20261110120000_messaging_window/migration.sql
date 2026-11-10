-- Enforce the platforms' messaging windows.
--
-- Contact.lastInboundAt is when the person last wrote, tapped a button or
-- arrived through a link: what opens the 24 hour window. Nullable, because no
-- earlier row recorded it, and an unknown time is treated as a closed window
-- for automated messages.
--
-- SKIPPED_WINDOW_CLOSED records a send the engine declined because the
-- platform would have refused it.
ALTER TABLE "Contact" ADD COLUMN "lastInboundAt" TIMESTAMP(3);

ALTER TYPE "DmStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_WINDOW_CLOSED';
