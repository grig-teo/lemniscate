-- Current pipeline-session anchor for the console elapsed timer: set when a
-- task enters an active status from idle/terminal, so reruns and re-reviews
-- measure only their own session instead of accumulating since createdAt.
ALTER TABLE "Task" ADD COLUMN "sessionStartedAt" TIMESTAMP(3);
