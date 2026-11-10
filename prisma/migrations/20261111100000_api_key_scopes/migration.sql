-- Scopes on workspace API keys. Empty means everything the key's role
-- allows, so every existing key keeps exactly the access it had.
ALTER TABLE "ApiKey" ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
