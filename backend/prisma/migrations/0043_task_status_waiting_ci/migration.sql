-- AlterEnum
-- This adds the 'waiting_ci' value to the TaskStatus enum, used while the PR
-- is open and CI checks are running (or being fixed) on the git host. The
-- task would otherwise show as 'awaiting review' for the entire CI window,
-- even though nothing is awaiting human review yet.
ALTER TYPE "TaskStatus" ADD VALUE 'waiting_ci';
