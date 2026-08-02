import { describe, expect, it } from 'vitest';

import { boardColumns, COLUMN_DEFS } from './task-board';
import type { Task } from './task-types';

// Locks the Kanban status→column mapping: the real 9 TaskStatus values land
// in exactly 4 columns (pending | processes | review | done), with failed/closed
// folded into Done. Col 1 also splits by kind (proposals vs saved prompts).
function task(status: Task['status'], kind: Task['kind'] = 'prompt', id = status): Task {
  return { id, kind, title: id, status } as Task;
}

describe('boardColumns status→column mapping', () => {
  it('maps pending to the Prompts/Proposals column', () => {
    const cols = boardColumns([task('pending')]);
    expect(cols[0].id).toBe('backlog');
    expect(cols[0].tasks.map((t) => t.id)).toEqual(['pending']);
  });

  it('maps queued/running/awaiting_plan_approval to Processes', () => {
    const cols = boardColumns([task('queued'), task('running'), task('awaiting_plan_approval')]);
    expect(cols[1].id).toBe('processes');
    expect(cols[1].tasks.map((t) => t.id)).toEqual(['queued', 'running', 'awaiting_plan_approval']);
  });

  it('maps awaiting_review/reviewing_code/waiting_ci to Code Review', () => {
    const cols = boardColumns([
      task('awaiting_review'),
      task('reviewing_code'),
      task('waiting_ci'),
    ]);
    expect(cols[2].id).toBe('review');
    expect(cols[2].tasks.map((t) => t.id)).toEqual([
      'awaiting_review',
      'reviewing_code',
      'waiting_ci',
    ]);
  });

  it('maps done/failed/closed to Done', () => {
    const cols = boardColumns([task('done'), task('failed'), task('closed')]);
    expect(cols[3].id).toBe('done');
    expect(cols[3].tasks.map((t) => t.id)).toEqual(['done', 'failed', 'closed']);
  });

  it('always returns exactly 4 columns in order, even when some are empty', () => {
    const cols = boardColumns([]);
    expect(cols.map((c) => c.id)).toEqual(['backlog', 'processes', 'review', 'done']);
    expect(cols.every((c) => c.tasks.length === 0)).toBe(true);
  });
});

describe('COLUMN_DEFS', () => {
  it('declares the 4 columns with stable ids and titles', () => {
    expect(COLUMN_DEFS.map((c) => [c.id, c.title])).toEqual([
      ['backlog', 'Prompts / Proposals'],
      ['processes', 'Processes'],
      ['review', 'Code Review'],
      ['done', 'Done'],
    ]);
  });
});
