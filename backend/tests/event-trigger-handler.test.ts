import { describe, expect, it, vi, beforeEach } from 'vitest';

// Unit tests for the event-trigger handler: the pure title builder + the
// trigger-to-task creation path with mocked Prisma and enqueueRunTask.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    repository: { findFirst: vi.fn() },
    eventTrigger: { findFirst: vi.fn() },
    task: { findFirst: vi.fn(), create: vi.fn() },
    llmConfig: { findFirst: vi.fn() },
  },
}));

vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueRunTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { triggerTaskTitle, fireEventTrigger } from '../src/lib/event-trigger-handler.js';
import { prisma } from '../src/lib/prisma.js';
import { enqueueRunTask } from '../src/lib/proposal-scheduler.js';
import type { WebhookEvent } from '../src/lib/git-providers/webhook-types.js';

describe('triggerTaskTitle', () => {
  it('builds a CI-failed title with the branch', () => {
    expect(triggerTaskTitle('ci_failed', 'main')).toBe('[Trigger] CI failed on main');
  });

  it('builds an issue-opened title without a branch suffix', () => {
    expect(triggerTaskTitle('issue_opened', '')).toBe('[Trigger] Issue opened');
  });

  it('truncates to 80 characters', () => {
    const longBranch = 'x'.repeat(100);
    const title = triggerTaskTitle('ci_failed', longBranch);
    expect(title.length).toBeLessThanOrEqual(80);
  });
});

const REPO_ID = 'repo-1';
const TRIGGER_ID = 'trigger-1';
const TASK_ID = 'task-new-1';
const LLM_CONFIG_ID = 'llm-1';

function ciFailedEvent(branch = 'main'): WebhookEvent {
  return {
    kind: 'ci_failed',
    repoFullName: 'org/demo',
    headBranch: branch,
    deliveryId: 'deliv-1',
  };
}

function issueOpenedEvent(): WebhookEvent {
  return {
    kind: 'issue_opened',
    repoFullName: 'org/demo',
    headBranch: '',
    deliveryId: 'deliv-2',
  };
}

function mockRepoFound() {
  return vi.mocked(prisma.repository.findFirst).mockResolvedValue({
    id: REPO_ID,
    llmConfigId: LLM_CONFIG_ID,
    skillSlugs: ['code-review'],
    connection: { userId: 'user-1' },
  });
}

describe('fireEventTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_triggerable for non-trigger events', async () => {
    const result = await fireEventTrigger({
      kind: 'pr_merged',
      repoFullName: 'org/demo',
      headBranch: 'main',
      deliveryId: null,
    });
    expect(result).toEqual({ fired: false, reason: 'not_triggerable' });
  });

  it('returns repo_not_found when the repository does not exist', async () => {
    vi.mocked(prisma.repository.findFirst).mockResolvedValue(null);
    const result = await fireEventTrigger(ciFailedEvent());
    expect(result).toEqual({ fired: false, reason: 'repo_not_found' });
  });

  it('returns no_trigger when no enabled EventTrigger matches', async () => {
    mockRepoFound();
    vi.mocked(prisma.eventTrigger.findFirst).mockResolvedValue(null);
    const result = await fireEventTrigger(ciFailedEvent());
    expect(result).toEqual({ fired: false, reason: 'no_trigger' });
  });

  it('returns duplicate when a task with the same title is already active', async () => {
    mockRepoFound();
    vi.mocked(prisma.eventTrigger.findFirst).mockResolvedValue({
      id: TRIGGER_ID,
      taskPrompt: 'Fix the CI failure',
    });
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 'existing-task' });
    const result = await fireEventTrigger(ciFailedEvent());
    expect(result).toEqual({ fired: false, reason: 'duplicate' });
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  it('creates and enqueues a task when the trigger fires', async () => {
    mockRepoFound();
    vi.mocked(prisma.eventTrigger.findFirst).mockResolvedValue({
      id: TRIGGER_ID,
      taskPrompt: 'Fix the CI failure on main',
    });
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.task.create).mockResolvedValue({ id: TASK_ID });

    const result = await fireEventTrigger(ciFailedEvent());

    expect(result).toEqual({ fired: true, reason: 'created' });
    expect(prisma.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositoryId: REPO_ID,
        kind: 'prompt',
        title: '[Trigger] CI failed on main',
        prompt: 'Fix the CI failure on main',
        status: 'queued',
        llmConfigId: LLM_CONFIG_ID,
      }),
      select: { id: true },
    });
    expect(enqueueRunTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('works for issue_opened events', async () => {
    mockRepoFound();
    vi.mocked(prisma.eventTrigger.findFirst).mockResolvedValue({
      id: TRIGGER_ID,
      taskPrompt: 'Investigate and fix the reported issue',
    });
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.task.create).mockResolvedValue({ id: TASK_ID });

    const result = await fireEventTrigger(issueOpenedEvent());

    expect(result).toEqual({ fired: true, reason: 'created' });
    expect(prisma.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: '[Trigger] Issue opened',
        prompt: 'Investigate and fix the reported issue',
      }),
      select: { id: true },
    });
  });

  it('returns no_llm_config when neither repo nor user default config exists', async () => {
    vi.mocked(prisma.repository.findFirst).mockResolvedValue({
      id: REPO_ID,
      llmConfigId: null,
      skillSlugs: null,
      connection: { userId: 'user-1' },
    });
    vi.mocked(prisma.eventTrigger.findFirst).mockResolvedValue({
      id: TRIGGER_ID,
      taskPrompt: 'Fix it',
    });
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.llmConfig.findFirst).mockResolvedValue(null);

    const result = await fireEventTrigger(ciFailedEvent());
    expect(result).toEqual({ fired: false, reason: 'no_llm_config' });
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});
