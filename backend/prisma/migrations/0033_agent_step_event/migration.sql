-- lemcore structured events: agent_step kind for per-step activity
-- (assistant messages + tool calls) streamed to the task console.
ALTER TYPE "TaskEventKind" ADD VALUE 'agent_step';
