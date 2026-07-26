-- Add the closed status: set when a task PR is closed on the git host
-- without merging (pr-state-sync).
ALTER TYPE "TaskStatus" ADD VALUE 'closed';
