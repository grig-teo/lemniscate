// Pause support for in-flight agent runs.
//
// A running task the user pauses (POST /tasks/:id/pause) flips its status to
// 'paused'. The executor loops poll this between turns / on the cancel-poll
// interval and, on detecting 'paused', throw TaskPausedError — a controlled
// exit that runTask treats as "paused, not failed": the transcript is already
// saved by the loop before throwing, the status is left as 'paused', and the
// workdir is kept so resume can replay it.
import { prisma } from './prisma.js';

/** Thrown by an executor when it detects the task was paused. */
export class TaskPausedError extends Error {
  constructor(
    public readonly taskId: string,
  ) {
    super('task paused by user');
    this.name = 'TaskPausedError';
  }
}

/**
 * True when the task's current status is 'paused'. Used by executor loops to
 * decide whether to stop on the next turn boundary (lemcore) or on the next
 * cancel-poll tick (hermes). Surfaces DB errors as "not paused" so a
 * transient blip never aborts a healthy run.
 */
export async function isTaskPaused(taskId: string): Promise<boolean> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    return task?.status === 'paused';
  } catch {
    return false;
  }
}

/**
 * Guarded pause exit: throws TaskPausedError only when the task is actually
 * paused. Executors call this at safe points (between turns, before/after a
 * tool batch) rather than mid-LLM-call, so a pause always lands on a clean
 * transcript boundary.
 */
export async function throwIfPaused(taskId: string): Promise<void> {
  if (await isTaskPaused(taskId)) {
    throw new TaskPausedError(taskId);
  }
}
