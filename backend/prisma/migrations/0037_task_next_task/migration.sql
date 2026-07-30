-- Manual task chaining: a task may declare a single successor ("next task")
-- that is queued automatically when this task reaches 'done'. The link is an
-- optional self-referential FK on Task (null = no successor). Stored as a
-- plain column rather than a join table because the design is a single
-- optional successor per task (no fan-out, no many-to-many).
ALTER TABLE "Task"
  ADD COLUMN "nextTaskId" TEXT;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_nextTaskId_fkey"
  FOREIGN KEY ("nextTaskId") REFERENCES "Task"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Fast lookup of "what chains off this task" when it completes.
CREATE INDEX "Task_nextTaskId_idx" ON "Task"("nextTaskId");
