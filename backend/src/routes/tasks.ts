import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { createTask, getTask, listTasks } from './task-crud-handlers.js';
import {
  archiveTask,
  cancelTask,
  closePrTask,
  improveTask,
  patchTask,
  rerunTask,
  startTask,
  switchTaskModel,
  unarchiveTask,
} from './task-action-handlers.js';
import { triggerMerge, triggerReview } from './task-review-handlers.js';
import { getTaskRunTargets } from './task-run-targets.js';
import { getTaskEvents } from './task-events-stream.js';
import { setFollowsTask } from './task-follows-handlers.js';

// Tasks API + SSE event stream. Registered under prefix `/api` (paths below
// include the `/tasks` segment, matching routes/repositories.ts).
//
// This module is the thin registration layer: zod schemas live in
// task-schemas.ts, lifecycle rules in task-lifecycle.ts, and the handlers in
// task-crud-handlers.ts / task-action-handlers.ts / task-run-targets.ts /
// task-events-stream.ts.

// Queue-flooding guard: task creation is throttled per route (the per-user
// active-task cap is enforced in createTask via TASK_MAX_ACTIVE_PER_USER).
const CREATE_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

const tasksRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.get('/tasks', listTasks);
  app.post('/tasks', { config: { rateLimit: CREATE_RATE_LIMIT } }, createTask);
  app.get('/tasks/:id', getTask);
  app.get('/tasks/:id/run-targets', getTaskRunTargets);
  app.post('/tasks/:id/start', startTask);
  app.patch('/tasks/:id', patchTask);
  app.post('/tasks/:id/model', switchTaskModel);
  app.post('/tasks/:id/improve', improveTask);
  app.post('/tasks/:id/rerun', rerunTask);
  app.post('/tasks/:id/cancel', cancelTask);
  app.post('/tasks/:id/close-pr', closePrTask);
  app.post('/tasks/:id/review', triggerReview);
  app.post('/tasks/:id/merge', triggerMerge);
  app.post('/tasks/:id/archive', archiveTask);
  app.post('/tasks/:id/unarchive', unarchiveTask);
  app.get('/tasks/:id/events', getTaskEvents);
};

// Re-exports so existing consumers (tests) keep a single import site.
export {
  improveBodySchema,
  modelBodySchema,
  patchBodySchema,
  startBodySchema,
  type ImproveBody,
  type ModelBody,
  type PatchBody,
  type StartBody,
} from './task-schemas.js';
export {
  archivedTasksWhere,
  attachmentValidationError,
  buildRerunUpdate,
  buildStartUpdate,
  closePrBlocker,
  findOwnedLlmConfig,
  initialTaskStatus,
  isArchivable,
  mergeBlocker,
  modelSwitchBlocker,
  resolveAttachmentUpdate,
  reviewBlocker,
  rerunBlocker,
  startBlocker,
  wantsSse,
} from './task-lifecycle.js';

export default tasksRoutes;
