-- When someone accepted the Terms, and which version they saw.
--
-- Additive and nullable. Deliberately NOT backfilled: every account created
-- before this column did not pass through a signup form carrying the notice,
-- and writing a date for them would be inventing the evidence this column
-- exists to hold.
ALTER TABLE "User"
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "termsVersion"    TEXT;
