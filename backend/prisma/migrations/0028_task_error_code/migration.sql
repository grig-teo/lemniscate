-- Structured error code for failed tasks. The backend classifies caught
-- exceptions (LLM auth, git permission, timeout, etc.) into a stable
-- string code via lib/errors.ts; the frontend maps each code to a
-- user-friendly banner with an actionable hint. Null for tasks that
-- succeeded or haven't run yet.
ALTER TABLE "Task" ADD COLUMN "errorCode" TEXT;
