-- Repo context digest columns: an LLM-written architecture map of the
-- default branch plus the HEAD SHA it was generated at. Runs regenerate it
-- only when the default branch moved, so per-task exploration turns (and
-- their tokens) are amortized across tasks instead of rebuilt from zero.
ALTER TABLE "Repository"
  ADD COLUMN "contextDigest" TEXT,
  ADD COLUMN "contextDigestSha" TEXT,
  ADD COLUMN "contextDigestAt" TIMESTAMP(3);
