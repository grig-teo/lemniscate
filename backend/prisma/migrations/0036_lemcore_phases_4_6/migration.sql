-- lemcore phases 4-6:
-- * planMode pauses a lemcore run after its first-turn plan until the user
--   approves it (new task status 'awaiting_plan_approval').
-- * requireToolApproval pauses individual mutating tool calls until the user
--   approves/denies them via /tasks/:id/steps/:stepId/decision.
-- * planner/editor model routing for lemcore rounds (null = standard
--   resolution: task override → repo llmConfigId → user default).
-- * ExecutorRunStat: per-repository per-executor run outcomes (the
--   hermes-vs-lemcore scoreboard in Settings).
ALTER TYPE "TaskStatus" ADD VALUE 'awaiting_plan_approval';

ALTER TABLE "Repository"
  ADD COLUMN "planMode" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requireToolApproval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "plannerLlmConfigId" TEXT,
  ADD COLUMN "editorLlmConfigId" TEXT;

CREATE TABLE "ExecutorRunStat" (
  "id" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "executor" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL,
  "tokensUsed" INTEGER NOT NULL DEFAULT 0,
  "wallTimeMs" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ExecutorRunStat_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutorRunStat_repositoryId_idx" ON "ExecutorRunStat"("repositoryId");

ALTER TABLE "ExecutorRunStat"
  ADD CONSTRAINT "ExecutorRunStat_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
