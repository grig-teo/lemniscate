import { describe, expect, it } from 'vitest';
import { archivedTasksWhere, isArchivable } from '../src/routes/tasks.js';

// Locking tests for POST /tasks/:id/archive eligibility: tasks in any status
// except running and queued (about to run) can be archived.
describe('isArchivable', () => {
  it.each(['running', 'queued'])('rejects %s tasks', (status) => {
    expect(isArchivable(status)).toBe(false);
  });

  it.each(['pending', 'awaiting_review', 'done', 'failed'])('allows %s tasks', (status) => {
    expect(isArchivable(status)).toBe(true);
  });
});

// GET /tasks archived filter: archived tasks are excluded by default;
// ?archived=true returns ONLY the archived ones.
describe('archivedTasksWhere', () => {
  it('excludes archived tasks by default', () => {
    expect(archivedTasksWhere(undefined)).toEqual({ archivedAt: null });
    expect(archivedTasksWhere(false)).toEqual({ archivedAt: null });
  });

  it('returns only archived tasks when archived is true', () => {
    expect(archivedTasksWhere(true)).toEqual({ archivedAt: { not: null } });
  });
});
