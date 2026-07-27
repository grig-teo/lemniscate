-- Per-user core agent override (Settings → Agent): NULL means the
-- deployment default (AGENT_EXECUTOR env) applies.
ALTER TABLE "User" ADD COLUMN "agentExecutor" TEXT;
