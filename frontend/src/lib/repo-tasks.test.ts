import { describe, expect, it } from 'vitest';

import type { Task } from '@/lib/hooks';
import {
  groupRepoTasks,
  isArchivable,
  isRerunnable,
  isStartableTask,
  proposalPollInterval,
  showsStatusBadge,
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
    llmTokensUsed: 0,
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

describe('showsStatusBadge', () => {
  it('hides the badge for unstarted tasks — the group label already says "pending"', () => {
    expect(showsStatusBadge(makeTask({}))).toBe(false);
    expect(showsStatusBadge(makeTask({ kind: 'prompt' }))).toBe(false);
  });

  it('shows the badge for started tasks of any kind', () => {
    expect(showsStatusBadge(makeTask({ status: 'running' }))).toBe(true);
    expect(showsStatusBadge(makeTask({ kind: 'prompt', status: 'done' }))).toBe(true);
  });
});

// Archive availability mirrors the backend UNARCHIVABLE_STATUSES: anything
// except running, queued (about to run), and reviewing_code (review in
// progress) tasks can be archived.
describe('isArchivable', () => {
  it.each(['running', 'queued', 'reviewing_code'])('rejects %s tasks', (status) => {
    expect(isArchivable(status)).toBe(false);
  });

  it.each(['pending', 'awaiting_review', 'done', 'failed', 'closed'])('allows %s tasks', (status) => {
    expect(isArchivable(status)).toBe(true);
  });
});

// Rerun availability mirrors the backend rerunBlocker: failed (including
// user-cancelled) and closed (PR closed without merge) tasks can be rerun.
describe('isRerunnable', () => {
  it.each(['failed', 'closed'])('allows %s tasks', (status) => {
    expect(isRerunnable(status)).toBe(true);
  });

  it.each(['pending', 'queued', 'running', 'reviewing_code', 'awaiting_review', 'done'])(
    'rejects %s tasks',
    (status) => {
      expect(isRerunnable(status)).toBe(false);
    },
  );
});
