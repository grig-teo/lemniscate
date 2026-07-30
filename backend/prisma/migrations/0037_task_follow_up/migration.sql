-- Manual task chaining: a task can declare a pending task in the same
-- repository that should be auto-started (enqueued) once this task reaches
-- 'done'. null = no follow-up. No foreign key (the reference is a soft
-- link validated at the API layer against pending same-repo tasks; a
-- cascade would erase the intent when the follow-up is deleted/archived).
ALTER TABLE "Task" ADD COLUMN "followUpTaskId" TEXT;
