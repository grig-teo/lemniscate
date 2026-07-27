import { prisma } from './prisma.js';
import { enqueueRunTask } from './proposal-scheduler.js';
import { parseSkillSlugs } from './task-skills.js';
import { logger } from './logger.js';
import type { WebhookEvent } from './git-providers/webhook-types.js';

// Event-driven trigger handler: when an inbound webhook delivers a ci_failed or
// issue_opened event, this checks for a matching enabled EventTrigger on the
// repository and creates + enqueues a prompt task using the trigger's prompt.
//
// Dedup: no task with the same trigger + event signature (kind + branch) is
// created while one is already queued/running — reuses the title-dedup pattern
// from agent-proposals.ts, adapted for trigger-sourced tasks.

/** Event kinds that can fire a trigger (subset of WebhookEventKind). */
export const TRIGGERABLE_EVENT_KINDS = ['ci_failed', 'issue_opened'] as const;
export type TriggerableEventKind = (typeof TRIGGERABLE_EVENT_KINDS)[number];

/** Title prefix that labels a task as trigger-sourced for the UI. */
const TRIGGER_TITLE_PREFIX = '[Trigger]';

function isTriggerable(kind: string): kind is TriggerableEventKind {
  return (TRIGGERABLE_EVENT_KINDS as readonly string[]).includes(kind);
}

/** Builds the task title for a trigger-created task. */
export function triggerTaskTitle(kind: TriggerableEventKind, branch: string): string {
  const label = kind === 'ci_failed' ? 'CI failed' : 'Issue opened';
  const suffix = branch ? ` on ${branch}` : '';
  return `${TRIGGER_TITLE_PREFIX} ${label}${suffix}`.slice(0, 80);
}

/** True when a task with the same trigger signature is queued/running. */
async function hasActiveTriggerTask(
  repositoryId: string,
  title: string,
): Promise<boolean> {
  const existing = await prisma.task.findFirst({
    where: {
      repositoryId,
      title,
      status: { in: ['pending', 'queued', 'running'] },
    },
    select: { id: true },
  });
  return existing !== null;
}

/** Finds an enabled EventTrigger for the event kind on the repository. */
async function findMatchingTrigger(
  repositoryId: string,
  eventKind: TriggerableEventKind,
) {
  return prisma.eventTrigger.findFirst({
    where: { repositoryId, eventKind, enabled: true },
    select: { id: true, taskPrompt: true },
  });
}

/** Resolves the LLM config: repo override, else user default. */
async function resolveTriggerLlmConfig(repository: {
  llmConfigId: string | null;
  connection: { userId: string };
}): Promise<string | null> {
  if (repository.llmConfigId) return repository.llmConfigId;
  const defaultConfig = await prisma.llmConfig.findFirst({
    where: { userId: repository.connection.userId, isDefault: true, enabled: true },
    select: { id: true },
  });
  return defaultConfig?.id ?? null;
}

/**
 * Attempts to fire an event trigger for the given webhook event. If a matching
 * enabled EventTrigger exists and no duplicate task is active, creates a prompt
 * task and enqueues it. Returns a description of the outcome.
 */
export async function fireEventTrigger(
  event: WebhookEvent,
): Promise<{ fired: boolean; reason: string }> {
  if (!isTriggerable(event.kind)) {
    return { fired: false, reason: 'not_triggerable' };
  }

  const repository = await prisma.repository.findFirst({
    where: { fullName: event.repoFullName },
    select: {
      id: true,
      llmConfigId: true,
      skillSlugs: true,
      connection: { select: { userId: true } },
    },
  });
  if (!repository) return { fired: false, reason: 'repo_not_found' };

  const trigger = await findMatchingTrigger(repository.id, event.kind);
  if (!trigger) return { fired: false, reason: 'no_trigger' };

  const title = triggerTaskTitle(event.kind, event.headBranch);
  if (await hasActiveTriggerTask(repository.id, title)) {
    return { fired: false, reason: 'duplicate' };
  }

  const llmConfigId = await resolveTriggerLlmConfig(repository);
  if (!llmConfigId) {
    logger.warn(
      { repositoryId: repository.id, eventKind: event.kind },
      'event trigger: no LLM config resolved, skipping task creation',
    );
    return { fired: false, reason: 'no_llm_config' };
  }

  const task = await prisma.task.create({
    data: {
      repositoryId: repository.id,
      kind: 'prompt',
      title,
      prompt: trigger.taskPrompt,
      status: 'queued',
      llmConfigId,
      skills: parseSkillSlugs(repository.skillSlugs),
    },
    select: { id: true },
  });
  await enqueueRunTask(task.id);
  logger.info(
    { taskId: task.id, repositoryId: repository.id, eventKind: event.kind },
    'event trigger: created and enqueued task',
  );
  return { fired: true, reason: 'created' };
}
