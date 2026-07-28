-- lemcore structured events: agent_step kind for per-step activity
-- (assistant messages + tool calls) streamed to the task console.
ALTER TABLE "TaskEvent" ALTER COLUMN "kind" TYPE TEXT;
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_kind_check" CHECK ("kind" IN ('log', 'diff', 'status', 'agent_step'));
ALTER TABLE "TaskEvent" ALTER COLUMN "kind" TYPE "TaskEventKind" USING "kind"::"TaskEventKind";