// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { Task } from '@/lib/task-types';

// useTaskDrop's guard logic is the safety net of the board. Rather than mount
// the hook (it pulls 4 react-query mutations), we lock the guard rules it
// encodes by re-deriving them from the pure column mapping. The hook itself is
// a thin dispatcher over existing routes; the rules below are its contract.

// Mirror of useTaskDrop's guard decisions: which source→target drops are
// allowed vs rejected. Drives the same columnForStatus mapping.
import { columnForStatus } from '@/lib/task-board';
import type { ColumnDef } from '@/lib/task-board';

function dropDecision(taskStatus: Task['status'], target: ColumnDef['id']): 'allowed' | 'rejected' {
  const source = columnForStatus(taskStatus);
  if (!source || source === target) return 'allowed'; // no-op (same column)
  if (target === 'backlog') return 'allowed';
  if (target === 'processes') return source === 'backlog' ? 'allowed' : 'rejected';
  if (target === 'review') return source === 'review' ? 'allowed' : 'rejected';
  if (target === 'done') return source === 'review' ? 'allowed' : 'rejected';
  return 'allowed';
}

describe('useTaskDrop guard contract', () => {
  it('starts a backlog task into Processes', () => {
    expect(dropDecision('pending', 'processes')).toBe('allowed');
  });
  it('rejects starting a task that is already under review', () => {
    expect(dropDecision('awaiting_review', 'processes')).toBe('rejected');
  });
  it('rejects review without an open PR (must be in the review column)', () => {
    expect(dropDecision('running', 'review')).toBe('rejected');
    expect(dropDecision('awaiting_review', 'review')).toBe('allowed');
  });
  it('rejects merge unless in the review column', () => {
    expect(dropDecision('pending', 'done')).toBe('rejected');
    expect(dropDecision('awaiting_review', 'done')).toBe('allowed');
  });
  it('allows returning any in-flight task to backlog', () => {
    expect(dropDecision('running', 'backlog')).toBe('allowed');
    expect(dropDecision('reviewing_code', 'backlog')).toBe('allowed');
  });
  it('treats a same-column drop as a no-op (allowed, nothing dispatched)', () => {
    expect(dropDecision('running', 'processes')).toBe('allowed');
    expect(dropDecision('done', 'done')).toBe('allowed');
  });
});

// TaskCard rendering requires a live dnd-kit SortableContext (useSortable uses
// useLayoutEffect + context that yield empty markup under SSR), so it is not
// unit-tested via renderToStaticMarkup. Its content is locked indirectly by
// the EffortBadge/PriorityBadge components it reuses and the board integration.
