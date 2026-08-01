-- AlterEnum
-- Adds the 'paused' value to the TaskStatus enum. A running task the user
-- pauses from the console flips to 'paused'; the running agent loop notices
-- on its next turn boundary, saves its transcript, and stops (instead of
-- failing). Resume flips it back to 'queued' and re-enqueues the run, which
-- replays the saved transcript. recoverInterruptedTasks ignores 'paused'
-- tasks (only 'running' is reset on worker start), so a paused task is never
-- auto-resumed behind the user's back.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'paused';
