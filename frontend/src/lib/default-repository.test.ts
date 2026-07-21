import { describe, expect, it } from 'vitest';

import { defaultRepositoryId } from '@/lib/default-repository';
import type { Repository } from '@/lib/hooks';
import type { SelectedTask } from '@/lib/selection';

function makeRepo(id: string): Repository {
  return {
    id,
    connectionId: 'c1',
    externalId: id,
    name: id,
    fullName: `ann/${id}`,
    cloneUrl: '',
    defaultBranch: 'main',
    autoPropose: false,
    autoCreatePr: false,
    autoReviewPr: false,
    autoMergePr: false,
    hidden: false,
    bare: false,
    connection: { provider: 'github', username: 'ann' },
  };
}

function makeTask(repositoryId: string): SelectedTask {
  return { id: 't1', title: 'Task', status: 'running', repositoryId };
}

describe('defaultRepositoryId', () => {
  it('returns an empty string when there are no repositories', () => {
    expect(defaultRepositoryId([], null)).toBe('');
    expect(defaultRepositoryId([], makeTask('r1'))).toBe('');
  });

  it('defaults to the first repository when no task is selected', () => {
    expect(defaultRepositoryId([makeRepo('r1'), makeRepo('r2')], null)).toBe('r1');
  });

  it("prefers the selected task's repository when it is in the list", () => {
    const repos = [makeRepo('r1'), makeRepo('r2')];
    expect(defaultRepositoryId(repos, makeTask('r2'))).toBe('r2');
  });

  it("falls back to the first repository when the selected task's repo is gone", () => {
    const repos = [makeRepo('r1'), makeRepo('r2')];
    expect(defaultRepositoryId(repos, makeTask('rX'))).toBe('r1');
  });

  it('falls back to the first repository when the selected task has no repositoryId', () => {
    const task: SelectedTask = { id: 't1', title: 'Task', status: 'done' };
    expect(defaultRepositoryId([makeRepo('r1')], task)).toBe('r1');
  });

  it('defaults to the selected repository when no task is selected', () => {
    const repos = [makeRepo('r1'), makeRepo('r2')];
    expect(defaultRepositoryId(repos, null, 'r2')).toBe('r2');
  });

  it("prefers the selected task's repository over the selected repository", () => {
    const repos = [makeRepo('r1'), makeRepo('r2'), makeRepo('r3')];
    expect(defaultRepositoryId(repos, makeTask('r3'), 'r2')).toBe('r3');
  });

  it('falls back to the first repository when the selected repository is gone', () => {
    const repos = [makeRepo('r1'), makeRepo('r2')];
    expect(defaultRepositoryId(repos, null, 'rX')).toBe('r1');
  });
});
