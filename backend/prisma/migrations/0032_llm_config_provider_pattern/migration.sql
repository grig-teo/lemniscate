-- LLM provider patterns: transport selection (openai|anthropic) and the
-- preset the config was created from (null = custom endpoint).
ALTER TABLE "LlmConfig" ADD COLUMN "apiPattern" TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE "LlmConfig" ADD COLUMN "provider" TEXT;
