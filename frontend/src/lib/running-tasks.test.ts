import { describe, expect, it } from 'vitest';

import type { Repository, Task, TaskStatus } from '@/lib/hooks';
import { groupTasksByRepository, selectRunningTasks } from '@/lib/running-tasks';

function makeTask(id: string, repositoryId: string, status: TaskStatus): Task {
  return {
    id,
    repositoryId,
    kind: 'prompt',
    title: `Task ${id}`,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeRepo(id: string, name: string): Repository {
  return {
    id,
    connectionId: `c-${id}`,
    externalId: id,
    name,
    fullName: `user/${name}`,
    cloneUrl: '',
    defaultBranch: 'main',
    autoPropose: false,
    autoCreatePr: false,
    autoReviewPr: false,
    autoMergePr: false,
    connection: { provider: 'github', username: 'user' },
  };
}

describe('selectRunningTasks', () => {
  it('keeps only queued and running tasks, preserving order', () => {
    const tasks = [
      makeTask('t1', 'r1', 'pending'),
      makeTask('t2', 'r1', 'queued'),
      makeTask('t3', 'r1', 'running'),
      makeTask('t4', 'r1', 'awaiting_review'),
      makeTask('t5', 'r1', 'done'),
      makeTask('t6', 'r1', 'failed'),
    ];
    expect(selectRunningTasks(tasks).map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('returns an empty list when nothing is queued or running', () => {
    expect(selectRunningTasks([makeTask('t1', 'r1', 'done')])).toEqual([]);
    expect(selectRunningTasks([])).toEqual([]);
  });
});

describe('groupTasksByRepository', () => {
  it('groups tasks under their repository name', () => {
    const groups = groupTasksByRepository(
      [makeTask('t1', 'r1', 'running'), makeTask('t2', 'r2', 'queued'), makeTask('t3', 'r1', 'queued')],
      [makeRepo('r1', 'alpha'), makeRepo('r2', 'beta')],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].repositoryName).toBe('alpha');
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(groups[1].repositoryName).toBe('beta');
    expect(groups[1].tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('falls back to "Unknown repository" for tasks without a matching repo', () => {
    const groups = groupTasksByRepository(
      [makeTask('t1', 'gone', 'running'), makeTask('t2', 'r1', 'running')],
      [makeRepo('r1', 'alpha')],
    );
    const unknown = groups.find((g) => g.repositoryName === 'Unknown repository');
    expect(unknown?.tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('keeps same-named repositories in separate groups', () => {
    const groups = groupTasksByRepository(
      [makeTask('t1', 'r1', 'running'), makeTask('t2', 'r2', 'running')],
      [makeRepo('r1', 'app'), makeRepo('r2', 'app')],
    );
    expect(groups).toHaveLength(2);
  });

  it('returns an empty list for no tasks', () => {
    expect(groupTasksByRepository([], [makeRepo('r1', 'alpha')])).toEqual([]);
  });
});
