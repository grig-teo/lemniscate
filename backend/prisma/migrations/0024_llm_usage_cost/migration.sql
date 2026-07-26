-- Prompt/completion token split on Task (nullable: rows that predate these
-- columns keep a NULL split; cost estimates cover new runs only) and optional
-- USD-per-million prices on LlmConfig (both required for cost estimates).

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "llmPromptTokens" INTEGER,
ADD COLUMN     "llmCompletionTokens" INTEGER;

-- AlterTable
ALTER TABLE "LlmConfig" ADD COLUMN     "inputPricePerMillion" DOUBLE PRECISION,
ADD COLUMN     "outputPricePerMillion" DOUBLE PRECISION;
