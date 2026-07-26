import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

// BullMQ queue shared by the API (enqueueing tasks) and the worker
// (repeatable schedulers + job dispatch). The queue name is pinned —
// the worker consumes the same name. Extracted from proposal-scheduler.ts
// so modules that only enqueue (e.g. lib/notifications.ts) do not pull in
// the agent-run import graph (import cycle, AGENTS.md §6: one home).

export const AGENT_QUEUE_NAME = 'agent-tasks';

let queue: Queue | null = null;

export function getAgentTasksQueue(): Queue {
  if (!queue) {
    queue = new Queue(AGENT_QUEUE_NAME, {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    });
  }
  return queue;
}
