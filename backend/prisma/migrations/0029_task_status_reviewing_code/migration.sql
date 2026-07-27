-- AlterEnum
-- This adds the 'reviewing_code' value to the TaskStatus enum, used while
-- the agent is actively reviewing a pull request (the task would otherwise
-- show as 'awaiting_review' during the entire review → fix → merge-gate
-- pipeline, making it impossible to distinguish active work from idle PRs).
ALTER TYPE "TaskStatus" ADD VALUE 'reviewing_code';
