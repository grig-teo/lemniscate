import { describe, expect, it } from 'vitest';

import type { Task } from '@/lib/hooks';
import {
  groupRepoTasks,
  isArchivable,
  isStartableTask,
  proposalPollInterval,
  sortByArchivedAtDesc,
  PROPOSAL_POLL_INTERVAL_MS,
  PROPOSAL_TARGET_COUNT,
} from '@/lib/repo-tasks';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    repositoryId: 'r1',
    kind: 'proposal',
    title: 'Do a thing',
    status: 'pending',
    archivedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function pendingProposals(count: number): Task[] {
  return Array.from({ length: count }, (_, i) => makeTask({ id: `t${i}` }));
}

describe('proposalPollInterval', () => {
  it('polls when no tasks have loaded yet', () => {
    expect(proposalPollInterval(undefined)).toBe(PROPOSAL_POLL_INTERVAL_MS);
  });

  it('polls while pending proposals are below the target count', () => {
    expect(proposalPollInterval([])).toBe(PROPOSAL_POLL_INTERVAL_MS);
    expect(proposalPollInterval(pendingProposals(PROPOSAL_TARGET_COUNT - 1))).toBe(
      PROPOSAL_POLL_INTERVAL_MS,
    );
  });

  it('stops polling once the target count of pending proposals is reached', () => {
    expect(proposalPollInterval(pendingProposals(PROPOSAL_TARGET_COUNT))).toBe(false);
    expect(proposalPollInterval(pendingProposals(PROPOSAL_TARGET_COUNT + 2))).toBe(false);
  });

  it('ignores non-proposal and started tasks', () => {
    const tasks = [
      ...pendingProposals(1),
      makeTask({ id: 'p1', kind: 'prompt' }),
      makeTask({ id: 's1', status: 'running' }),
    ];
    expect(proposalPollInterval(tasks)).toBe(PROPOSAL_POLL_INTERVAL_MS);
  });
});

describe('sortByArchivedAtDesc', () => {
  it('orders most recently archived first without mutating the input', () => {
    const tasks = [
      makeTask({ id: 'old', archivedAt: '2024-01-01T00:00:00Z' }),
      makeTask({ id: 'new', archivedAt: '2024-03-01T00:00:00Z' }),
      makeTask({ id: 'mid', archivedAt: '2024-02-01T00:00:00Z' }),
    ];
    const sorted = sortByArchivedAtDesc(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['new', 'mid', 'old']);
    expect(tasks.map((t) => t.id)).toEqual(['old', 'new', 'mid']);
  });

  it('sorts tasks with a null archivedAt last', () => {
    const tasks = [
      makeTask({ id: 'null', archivedAt: null }),
      makeTask({ id: 'archived', archivedAt: '2024-01-01T00:00:00Z' }),
    ];
    expect(sortByArchivedAtDesc(tasks).map((t) => t.id)).toEqual(['archived', 'null']);
  });
});

describe('groupRepoTasks', () => {
  it('splits tasks into proposals, saved-for-later prompts, and processes', () => {
    const tasks = [
      makeTask({ id: 'proposal' }),
      makeTask({ id: 'later-prompt', kind: 'prompt' }),
      makeTask({ id: 'running-prompt', kind: 'prompt', status: 'running' }),
      makeTask({ id: 'done-proposal', status: 'done' }),
    ];
    const groups = groupRepoTasks(tasks);
    expect(groups.proposals.map((t) => t.id)).toEqual(['proposal']);
    expect(groups.prompts.map((t) => t.id)).toEqual(['later-prompt']);
    expect(groups.processes.map((t) => t.id)).toEqual(['running-prompt', 'done-proposal']);
  });
});

describe('isStartableTask', () => {
  it('allows pending proposals and pending prompts', () => {
    expect(isStartableTask(makeTask({}))).toBe(true);
    expect(isStartableTask(makeTask({ kind: 'prompt' }))).toBe(true);
  });

  it('rejects started tasks and other kinds', () => {
    expect(isStartableTask(makeTask({ status: 'queued' }))).toBe(false);
    expect(isStartableTask(makeTask({ kind: 'review' }))).toBe(false);
  });
});

// Archive availability mirrors the backend: anything except running and
// queued (about to run) tasks can be archived.
describe('isArchivable', () => {
  it.each(['running', 'queued'])('rejects %s tasks', (status) => {
    expect(isArchivable(status)).toBe(false);
  });

  it.each(['pending', 'awaiting_review', 'done', 'failed'])('allows %s tasks', (status) => {
    expect(isArchivable(status)).toBe(true);
  });
});
