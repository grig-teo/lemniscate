import { describe, expect, it, vi } from 'vitest';

// Locking tests for the pure follow-up helpers in task-lifecycle.ts:
//   * followUpValidationError — falsy/undefined input is a no-op (returns
//     null without touching the DB), so every call site can pass the field
//     straight through without a guard (AGENTS.md §6 single source of truth).
//   * followUpUpdateData — shapes the partial { followUpTaskId } spread for a
//     Prisma create/update so a store never writes `undefined`. Only undefined
//     collapses to {} (Prisma "ignore"); null and a real id are kept.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { findFirst: vi.fn() },
  },
}));

import { followUpUpdateData, followUpValidationError } from '../src/routes/task-lifecycle.js';

describe('followUpValidationError', () => {
  it('is a no-op (returns null) for undefined input without querying', async () => {
    expect(await followUpValidationError(undefined, 'repo-1')).toBeNull();
    expect(await followUpValidationError(null, 'repo-1')).toBeNull();
  });

  it('is a no-op for an empty string without querying', async () => {
    expect(await followUpValidationError('', 'repo-1')).toBeNull();
  });
});

describe('followUpUpdateData', () => {
  it('collapses undefined to an empty object (Prisma ignores it)', () => {
    expect(followUpUpdateData(undefined)).toEqual({});
  });

  it('keeps a real follow-up id', () => {
    expect(followUpUpdateData('next-task')).toEqual({ followUpTaskId: 'next-task' });
  });

  it('keeps null so the follow-up can be cleared', () => {
    expect(followUpUpdateData(null)).toEqual({ followUpTaskId: null });
  });
});
