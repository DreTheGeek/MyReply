-- Remove the Zernio provider.
--
-- Zernio was upstream's second route to Instagram: a paid third-party API that
-- lets someone connect without their own Meta app. MyReply runs its own Meta
-- app and goes through App Review, so every account connects through Meta
-- directly and nothing pays a middleman. No code reads these any more.
--
-- Every production account is a META account (Zernio was never configured on
-- this deployment), so dropping the column loses no information.
DROP TABLE IF EXISTS "ZernioConnection";
ALTER TABLE "InstagramAccount" DROP COLUMN IF EXISTS "provider";
ALTER TABLE "InstagramAccount" DROP COLUMN IF EXISTS "zernioAccountId";
DROP TYPE IF EXISTS "InstagramProvider";
