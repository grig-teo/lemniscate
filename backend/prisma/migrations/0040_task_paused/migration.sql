-- User-initiated pause/resume of running processes: the agent job parks (or
-- unqueues) with its workdir + lemcore transcript intact so a later resume
-- continues the implementation instead of starting over.
ALTER TYPE "TaskStatus" ADD VALUE 'paused';
