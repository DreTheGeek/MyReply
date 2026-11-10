-- Which platform a connected account belongs to.
--
-- Every existing row is Instagram, which is what the default fills in, so
-- this is additive and touches no data the engine reads today. It is what lets
-- the engine route each account to its platform's adapter.
CREATE TYPE "ChannelPlatform" AS ENUM ('INSTAGRAM');

ALTER TABLE "InstagramAccount"
  ADD COLUMN "platform" "ChannelPlatform" NOT NULL DEFAULT 'INSTAGRAM';
