import { prisma } from './prisma.js';
import { enqueueRunTask } from './proposal-scheduler.js';

// Manual task chaining: a task may point at a still-pending task in the same
// repository that should be auto-started once it reaches 'done'. This module
// resolves that pointer (defense-in-depth: re-checked at trigger time, not
// just at create/PATCH) and starts the follow-up, then clears the pointer so
// a done task never chains twice. The enqueue helper lives in
// proposal-scheduler.js (single home), re-exported from queue.ts.

// Only id is needed; the columns that gate eligibility are filtered in `where`.
const FOLLOW_UP_SELECT = { id: true } as const;

function eligibleFollowUpWhere(followUpTaskId: string, repositoryId: string) {
  return {
    where: {
      id: followUpTaskId,
      status: 'pending' as const,
      repositoryId,
      archivedAt: null,
    },
    select: FOLLOW_UP_SELECT,
  };
}

/**
 * Resolves a task's followUpTaskId to a still-runnable task id, or null when
 * there is none set, the target was already started/archived, or it belongs
 * to a different repository. Re-checks pending + same-repo + active at read
 * time so a race between create and trigger (the target gets started,
 * archived, or moved) can never resurrect a stale pointer.
 */
export async function resolveFollowUp(
  taskId: string,
  repositoryId: string,
): Promise<string | null> {
  const task = await prisma.task.findFirst({
    where: { id: taskId },
    select: { followUpTaskId: true },
  });
  const followUpTaskId = task?.followUpTaskId ?? null;
  if (!followUpTaskId) return null;
  const eligible = await prisma.task.findFirst(eligibleFollowUpWhere(followUpTaskId, repositoryId));
  return eligible?.id ?? null;
}

/**
 * Starts the configured follow-up of a done task (if any) and clears the
 * pointer in one step. Enqueue happens before the clear so a failed enqueue
 * leaves the pointer intact for a later retry; the follow-up is not
 * double-enqueued because the eligibility check excludes non-pending tasks
 * and enqueueRunTask jobIds dedupe. A null followUpTaskId short-circuits.
 */
export async function startFollowUpTask(
  taskId: string,
  repositoryId: string,
  followUpTaskId: string | null,
): Promise<void> {
  if (!followUpTaskId) return;
  const nextId = await followUpIdIfEligible(followUpTaskId, repositoryId);
  if (!nextId) return;
  await enqueueRunTask(nextId);
  await prisma.task.update({
    where: { id: taskId },
    data: { followUpTaskId: null },
  });
}

// Eligibility check shared by both entry points: the pointed-at task must
// still be pending, in the same repository, and not archived.
async function followUpIdIfEligible(
  followUpTaskId: string,
  repositoryId: string,
): Promise<string | null> {
  const eligible = await prisma.task.findFirst(eligibleFollowUpWhere(followUpTaskId, repositoryId));
  return eligible?.id ?? null;
}
