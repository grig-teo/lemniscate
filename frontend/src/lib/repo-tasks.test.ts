import { describe, expect, it } from 'vitest';

import type { Task, TaskStatus } from '@/lib/hooks';
import { isPendingProposal, PROPOSAL_TARGET_COUNT, splitRepoTasks } from '@/lib/repo-tasks';

function makeTask(id: string, status: TaskStatus, kind = 'prompt'): Task {
  return {
    id,
    repositoryId: 'r1',
    kind,
    title: `Task ${id}`,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('isPendingProposal', () => {
  it('is true only for proposal tasks still pending', () => {
    expect(isPendingProposal(makeTask('t1', 'pending', 'proposal'))).toBe(true);
  });

  it('is false for started proposals and pending prompts', () => {
    expect(isPendingProposal(makeTask('t1', 'queued', 'proposal'))).toBe(false);
    expect(isPendingProposal(makeTask('t2', 'pending', 'prompt'))).toBe(false);
  });
});

describe('splitRepoTasks', () => {
  it('puts fresh proposals first and everything else in processes, order preserved', () => {
    const tasks = [
      makeTask('p1', 'pending', 'proposal'),
      makeTask('r1', 'running', 'prompt'),
      makeTask('p2', 'pending', 'proposal'),
      makeTask('q1', 'queued', 'proposal'),
    ];
    const { proposals, processes } = splitRepoTasks(tasks);
    expect(proposals.map((t) => t.id)).toEqual(['p1', 'p2']);
    expect(processes.map((t) => t.id)).toEqual(['r1', 'q1']);
  });

  it('returns empty groups for no tasks', () => {
    expect(splitRepoTasks([])).toEqual({ proposals: [], processes: [] });
  });
});

describe('PROPOSAL_TARGET_COUNT', () => {
  it('is 5 (the badge target)', () => {
    expect(PROPOSAL_TARGET_COUNT).toBe(5);
  });
});
