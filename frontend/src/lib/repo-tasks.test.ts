import { describe, expect, it } from 'vitest';

import type { Task } from '@/lib/hooks';
import {
  proposalPollInterval,
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
