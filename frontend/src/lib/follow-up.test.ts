import { describe, expect, it } from 'vitest';

import { followUpCandidates, followUpStatusLabel, isFollowUpCandidate } from '@/lib/follow-up';
import type { Task } from '@/lib/task-types';

// Locks the follow-up dropdown's eligibility rule: all tasks of the repo are
// candidates (proposals, prompts running, in review, code review, done, …)
// EXCEPT archived tasks and the predecessor itself.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'prompt',
    title: 'Add throttling',
    status: 'pending',
    repositoryId: 'repo-1',
    archivedAt: null,
    llmTokensUsed: 0,
    nextTaskId: null,
    ...overrides,
  } as Task;
}

describe('isFollowUpCandidate', () => {
  it.each([
    'pending',
    'queued',
    'running',
    'awaiting_review',
    'reviewing_code',
    'done',
    'failed',
    'closed',
  ])('accepts %s tasks', (status) => {
    expect(isFollowUpCandidate(makeTask({ status }), 'other')).toBe(true);
  });

  it('rejects the predecessor itself', () => {
    expect(isFollowUpCandidate(makeTask({ id: 'me' }), 'me')).toBe(false);
  });

  it('rejects archived tasks', () => {
    const archived = makeTask({ archivedAt: '2026-01-01T00:00:00.000Z' });
    expect(isFollowUpCandidate(archived, 'other')).toBe(false);
  });

  it('keeps the currently linked (archived) task out of the list', () => {
    const archived = makeTask({ id: 'linked', archivedAt: '2026-01-01T00:00:00.000Z' });
    const active = makeTask({ id: 'active' });
    expect(followUpCandidates([archived, active], 'predecessor').map((t) => t.id)).toEqual([
      'active',
    ]);
  });
});

describe('followUpStatusLabel', () => {
  it('humanizes snake_case statuses', () => {
    expect(followUpStatusLabel('awaiting_review')).toBe('awaiting review');
    expect(followUpStatusLabel('reviewing_code')).toBe('reviewing code');
    expect(followUpStatusLabel('pending')).toBe('pending');
  });
});
