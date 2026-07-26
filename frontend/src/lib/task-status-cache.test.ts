import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { Task } from '@/lib/hooks';
import { applyTaskStatusToCaches } from '@/lib/task-status-cache';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    repositoryId: 'r1',
    kind: 'proposal',
    title: 'Do a thing',
    status: 'queued',
    archivedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function seededClient() {
  const client = new QueryClient();
  client.setQueryData<Task[]>(['tasks', 'r1', 'active'], [
    makeTask({ id: 't1' }),
    makeTask({ id: 't2', status: 'done' }),
  ]);
  client.setQueryData<Task[]>(['tasks', null, 'active'], [makeTask({ id: 't1' })]);
  client.setQueryData<Task>(['task', 't1'], makeTask({ id: 't1' }));
  return client;
}

describe('applyTaskStatusToCaches', () => {
  it('writes the live status into every cached task list containing the task', () => {
    const client = seededClient();
    applyTaskStatusToCaches(client, 't1', 'running');
    expect(client.getQueryData<Task[]>(['tasks', 'r1', 'active'])?.[0].status).toBe('running');
    expect(client.getQueryData<Task[]>(['tasks', null, 'active'])?.[0].status).toBe('running');
  });

  it('leaves other tasks in the same list untouched', () => {
    const client = seededClient();
    applyTaskStatusToCaches(client, 't1', 'running');
    const other = client.getQueryData<Task[]>(['tasks', 'r1', 'active'])?.[1];
    expect(other).toMatchObject({ id: 't2', status: 'done' });
  });

  it('updates the single-task detail cache', () => {
    const client = seededClient();
    applyTaskStatusToCaches(client, 't1', 'done');
    expect(client.getQueryData<Task>(['task', 't1'])?.status).toBe('done');
  });

  it('is a no-op for lists without the task and does not create new caches', () => {
    const client = new QueryClient();
    client.setQueryData<Task[]>(['tasks', 'r2', 'active'], [makeTask({ id: 't9' })]);
    applyTaskStatusToCaches(client, 't1', 'running');
    expect(client.getQueryData<Task[]>(['tasks', 'r2', 'active'])?.[0].status).toBe('queued');
    expect(client.getQueryData(['tasks', 'r1', 'active'])).toBeUndefined();
    expect(client.getQueryData(['task', 't1'])).toBeUndefined();
  });

  it('does not clobber unrelated queries sharing the tasks key prefix root', () => {
    const client = seededClient();
    client.setQueryData(['task-events', 't1'], [{ id: 'e1' }]);
    applyTaskStatusToCaches(client, 't1', 'failed');
    expect(client.getQueryData(['task-events', 't1'])).toEqual([{ id: 'e1' }]);
  });
});
