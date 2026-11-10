-- What each automated answer cost: the model, the tokens, and the provider's
-- own cost figure in millionths of a dollar. Additive and nullable; earlier
-- answers recorded none of it.
ALTER TABLE "AssistantAnswer"
  ADD COLUMN "model" TEXT,
  ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "costMicros" INTEGER;
