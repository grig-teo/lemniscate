import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { logEvent } from './agent-git.js';
import { enqueueRunTask } from './proposal-scheduler.js';

// Manual task chaining (the "follow-up task" feature): a task may declare a
// successor via Task.nextTaskId. When the predecessor reaches 'done', that
// successor is auto-queued (started). This module owns the firing logic and
// the lifecycle helpers (validate/set/clear the link); the single home for it
// per AGENTS.md §6.

const STARTABLE_STATUSES = ['pending', 'queued'] as const;

/**
 * Whether a successor is eligible to be auto-queued: it must still be in an
 * idle state (pending/queued). A task that the user has already started, or
 * that already ran (done/failed/closed/…), is skipped so a stale manual link
 * never resurrects or interrupts a live run.
 */
function isStartable(status: string): status is (typeof STARTABLE_STATUSES)[number] {
  return (STARTABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Fire the manual successor chain for a task that just completed.
 *
 * Looks up the predecessor's nextTaskId; if the successor is still idle it is
 * queued (enqueueRunTask) and the link is cleared on the predecessor (so a
 * rerun/re-merge of the predecessor cannot fire it twice). All failures are
 * caught and logged — chaining is best-effort and must never break the
 * completion path of the predecessor itself.
 *
 * Returns the queued successor's id, or null when there was no link / the
 * successor was no longer eligible.
 */
export async function triggerNextTask(predecessorId: string): Promise<string | null> {
  let predecessor: { nextTaskId: string | null } | null = null;
  try {
    predecessor = await prisma.task.findUnique({
      where: { id: predecessorId },
      select: { nextTaskId: true },
    });
  } catch (err) {
    logger.error({ predecessorId, err }, 'task-next: failed to load predecessor');
    return null;
  }
  const nextTaskId = predecessor?.nextTaskId;
  if (!nextTaskId) return null;

  try {
    const next = await prisma.task.findUnique({
      where: { id: nextTaskId },
      select: { id: true, status: true, title: true },
    });
    if (!next) {
      // Successor vanished (deleted). Drop the now-dangling link.
      await prisma.task.update({
        where: { id: predecessorId },
        data: { nextTaskId: null },
      });
      logger.warn({ predecessorId, nextTaskId }, 'task-next: successor missing; cleared link');
      return null;
    }
    if (!isStartable(next.status)) {
      // Successor is no longer idle (already running / terminal): leave the
      // link intact but don't fire — the user took it over manually.
      logger.info(
        { predecessorId, nextTaskId, status: next.status },
        'task-next: successor not idle; skipping',
      );
      return null;
    }

    await logEvent(nextTaskId, `auto-started as the follow-up to ${predecessorId}`);
    await enqueueRunTask(nextTaskId);
    // Clear the link so a rerun/re-merge of the predecessor is idempotent.
    await prisma.task.update({
      where: { id: predecessorId },
      data: { nextTaskId: null },
    });
    logger.info({ predecessorId, nextTaskId }, 'task-next: queued successor');
    return nextTaskId;
  } catch (err) {
    logger.error({ predecessorId, nextTaskId, err }, 'task-next: failed to queue successor');
    return null;
  }
}
