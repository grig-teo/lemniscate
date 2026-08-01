import { describe, expect, it } from 'vitest';

import type { TaskEventItem } from '@/lib/task-types';
import {
  countDiffHunkLines,
  deriveChangeAction,
  fileChangeTotals,
  isCreatedDiff,
  mergeDiffEvent,
  parseDiffLines,
  parseEventDiff,
  summarizeChanges,
  type FileChange,
} from '@/lib/session-changes';

function event(payload: unknown, id = 'e1'): TaskEventItem {
  return { id, kind: 'diff', payload, createdAt: '2026-08-01T00:00:00Z' };
}

const SIMPLE_DIFF = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' line one',
  '-old line',
  '+new line',
  '+extra line',
].join('\n');

// Real backend format (agent-git.ts publishWriteDiff): raw file content
// appended after the /dev/null header, with NO '+' prefixes on content lines.
const CREATED_DIFF = ['--- /dev/null', '+++ b/src/new.ts', 'first', 'second'].join('\n');

describe('parseEventDiff', () => {
  it('reads the path and diff text from a { path, diff } payload', () => {
    expect(parseEventDiff({ path: 'src/a.ts', diff: SIMPLE_DIFF })).toEqual({
      path: 'src/a.ts',
      diff: SIMPLE_DIFF,
    });
  });

  it('returns null for action payloads and malformed shapes', () => {
    expect(parseEventDiff({ path: 'src/a.ts', action: 'deleted' })).toBeNull();
    expect(parseEventDiff({ diff: SIMPLE_DIFF })).toBeNull();
    expect(parseEventDiff(null)).toBeNull();
    expect(parseEventDiff('nope')).toBeNull();
  });
});

describe('isCreatedDiff', () => {
  it('treats a /dev/null old side as file creation', () => {
    expect(isCreatedDiff('--- /dev/null\n+++ b/x.ts')).toBe(true);
  });

  it('treats any other old side as modification', () => {
    expect(isCreatedDiff('--- a/x.ts\n+++ b/x.ts')).toBe(false);
    expect(isCreatedDiff('no headers at all')).toBe(false);
  });
});

describe('deriveChangeAction', () => {
  it('prefers an explicit action field', () => {
    expect(deriveChangeAction({ path: 'x', action: 'deleted' })).toBe('deleted');
    expect(deriveChangeAction({ path: 'x', action: 'conflict-resolved' })).toBe(
      'conflict-resolved',
    );
  });

  it('derives created/modified from the diff headers', () => {
    expect(deriveChangeAction({ path: 'x', diff: CREATED_DIFF })).toBe('created');
    expect(deriveChangeAction({ path: 'x', diff: SIMPLE_DIFF })).toBe('modified');
  });

  it('falls back to modified when neither field is usable', () => {
    expect(deriveChangeAction({ path: 'x' })).toBe('modified');
  });
});

describe('countDiffHunkLines', () => {
  it('counts + and - lines inside hunks only, ignoring headers', () => {
    expect(countDiffHunkLines(SIMPLE_DIFF)).toEqual({ added: 2, removed: 1 });
  });

  it('counts the raw content lines of a /dev/null creation preview as additions', () => {
    expect(countDiffHunkLines(CREATED_DIFF)).toEqual({ added: 2, removed: 0 });
  });

  it('counts every content line of a creation preview, even diff-looking ones', () => {
    const diff = ['--- /dev/null', '+++ b/x.md', '--- not a header', '@@ nope', '+plus'].join('\n');
    expect(countDiffHunkLines(diff)).toEqual({ added: 3, removed: 0 });
  });

  it('does not count the trailing newline of a creation preview as an extra line', () => {
    const diff = '--- /dev/null\n+++ b/x.ts\nonly line\n';
    expect(countDiffHunkLines(diff)).toEqual({ added: 1, removed: 0 });
  });

  it('returns zeros when there is no diff text', () => {
    expect(countDiffHunkLines(undefined)).toEqual({ added: 0, removed: 0 });
  });
});

describe('fileChangeTotals', () => {
  it('sums the creation preview and the latest diff of one file', () => {
    const change: FileChange = {
      path: 'src/a.ts',
      action: 'modified',
      diff: SIMPLE_DIFF,
      baseDiff: CREATED_DIFF,
    };
    expect(fileChangeTotals(change)).toEqual({ added: 4, removed: 1 });
  });

  it('counts a lone diff and no diff at all', () => {
    expect(fileChangeTotals({ path: 'a', action: 'modified', diff: SIMPLE_DIFF })).toEqual({
      added: 2,
      removed: 1,
    });
    expect(fileChangeTotals({ path: 'a', action: 'deleted' })).toEqual({ added: 0, removed: 0 });
  });
});

describe('mergeDiffEvent', () => {
  it('replaces the previous cumulative diff instead of keeping it as the base', () => {
    const first: FileChange = { path: 'src/a.ts', action: 'created' };
    const merged = mergeDiffEvent(first, { path: 'src/a.ts', diff: SIMPLE_DIFF });
    expect(merged?.diff).toBe(SIMPLE_DIFF);
    expect(merged?.baseDiff).toBeUndefined();
    // Modify events carry a cumulative `git diff -- <rel>`: the newest one
    // fully replaces the old, nothing is double-counted as baseDiff.
    const again = mergeDiffEvent(merged ?? undefined, { path: 'src/a.ts', diff: 'second diff' });
    expect(again?.diff).toBe('second diff');
    expect(again?.baseDiff).toBeUndefined();
  });

  it('keeps the creation preview as the base when a created file is modified', () => {
    const created: FileChange = { path: 'src/a.ts', action: 'created', diff: CREATED_DIFF };
    const merged = mergeDiffEvent(created, { path: 'src/a.ts', diff: SIMPLE_DIFF });
    expect(merged?.diff).toBe(SIMPLE_DIFF);
    expect(merged?.baseDiff).toBe(CREATED_DIFF);
  });

  it('drops the file when it is deleted after being created in the same session', () => {
    const created: FileChange = { path: 'src/a.ts', action: 'created', diff: CREATED_DIFF };
    expect(mergeDiffEvent(created, { path: 'src/a.ts', action: 'deleted' })).toBeNull();
  });

  it('marks a pre-existing file as deleted without a diff', () => {
    const modified: FileChange = { path: 'src/a.ts', action: 'modified', diff: SIMPLE_DIFF };
    const merged = mergeDiffEvent(modified, { path: 'src/a.ts', action: 'deleted' });
    expect(merged).toEqual({ path: 'src/a.ts', action: 'deleted' });
  });

  it('keeps a deletion with no prior event', () => {
    expect(mergeDiffEvent(undefined, { path: 'src/a.ts', action: 'deleted' })).toEqual({
      path: 'src/a.ts',
      action: 'deleted',
    });
  });

  it('updates the action for non-delete action events (e.g. conflict-resolved)', () => {
    const modified: FileChange = { path: 'src/a.ts', action: 'modified', diff: SIMPLE_DIFF };
    const merged = mergeDiffEvent(modified, { path: 'src/a.ts', action: 'conflict-resolved' });
    expect(merged?.action).toBe('conflict-resolved');
    expect(merged?.diff).toBe(SIMPLE_DIFF);
    // No diff on the event: the previous diff must not be duplicated as base.
    expect(merged?.baseDiff).toBeUndefined();
  });

  it('keeps the creation preview as the sole diff on a conflict-resolved event', () => {
    const created: FileChange = { path: 'src/a.ts', action: 'created', diff: CREATED_DIFF };
    const merged = mergeDiffEvent(created, { path: 'src/a.ts', action: 'conflict-resolved' });
    expect(merged?.diff).toBe(CREATED_DIFF);
    expect(merged?.baseDiff).toBeUndefined();
  });
});

describe('parseDiffLines', () => {
  it('parses a full-file diff of a file created earlier in the session', () => {
    const change: FileChange = {
      path: 'src/a.ts',
      action: 'modified',
      diff: SIMPLE_DIFF,
      baseDiff: CREATED_DIFF,
    };
    expect(parseDiffLines(change)).toEqual([
      { kind: 'meta', text: '--- /dev/null' },
      { kind: 'meta', text: '+++ b/src/new.ts' },
      { kind: 'add', text: 'first' },
      { kind: 'add', text: 'second' },
      { kind: 'meta', text: '' },
      { kind: 'meta', text: '--- a/src/a.ts' },
      { kind: 'meta', text: '+++ b/src/a.ts' },
      { kind: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { kind: 'ctx', text: 'line one' },
      { kind: 'del', text: 'old line' },
      { kind: 'add', text: 'new line' },
      { kind: 'add', text: 'extra line' },
    ]);
  });

  it('renders raw creation-preview content as additions, even diff-looking lines', () => {
    const change: FileChange = {
      path: 'x.md',
      action: 'created',
      diff: ['--- /dev/null', '+++ b/x.md', '# title', '--- looks like a header'].join('\n'),
    };
    expect(parseDiffLines(change)).toEqual([
      { kind: 'meta', text: '--- /dev/null' },
      { kind: 'meta', text: '+++ b/x.md' },
      { kind: 'add', text: '# title' },
      { kind: 'add', text: '--- looks like a header' },
    ]);
  });

  it('parses hunks, context, additions and removals of a regular diff', () => {
    const lines = parseDiffLines({ path: 'src/a.ts', action: 'modified', diff: SIMPLE_DIFF });
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add']);
    expect(lines[5]).toEqual({ kind: 'add', text: 'new line' });
  });

  it('keeps \\ No newline at end of file markers as context', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b';
    const kinds = parseDiffLines({ path: 'x', action: 'modified', diff }).map((l) => l.kind);
    expect(kinds).toEqual(['meta', 'meta', 'hunk', 'del', 'ctx', 'add']);
  });

  it('returns an info row when no diff text is available', () => {
    const lines = parseDiffLines({ path: 'x', action: 'deleted' });
    expect(lines).toEqual([{ kind: 'meta', text: 'No textual diff available.' }]);
  });
});

describe('summarizeChanges', () => {
  it('reduces diff events to one row per file with totals', () => {
    const events = [
      event({ path: 'src/a.ts', diff: CREATED_DIFF }, 'e1'),
      event({ path: 'src/a.ts', diff: SIMPLE_DIFF }, 'e2'),
      event({ path: 'src/b.ts', diff: SIMPLE_DIFF }, 'e3'),
      event({ path: 'src/c.ts', action: 'deleted' }, 'e4'),
      event({ path: 'src/d.ts', diff: CREATED_DIFF }, 'e5'),
      event({ path: 'src/d.ts', action: 'deleted' }, 'e6'),
    ];
    const summary = summarizeChanges(events);
    expect(summary.changes.map((c) => `${c.path}:${c.action}`)).toEqual([
      'src/a.ts:modified',
      'src/b.ts:modified',
      'src/c.ts:deleted',
    ]);
    // a.ts: 2 created + (2 added − 1 removed); b.ts: +2/−1; c.ts: 0/0
    expect(summary.additions).toBe(2 + 2 + 2);
    expect(summary.deletions).toBe(1 + 1);
    expect(summary.count).toBe(3);
  });

  it('counts a file once when a conflict-resolved event carries no diff', () => {
    const events = [
      event({ path: 'src/a.ts', diff: SIMPLE_DIFF }, 'e1'),
      event({ path: 'src/a.ts', action: 'conflict-resolved' }, 'e2'),
    ];
    const summary = summarizeChanges(events);
    expect(summary.count).toBe(1);
    expect(summary.additions).toBe(2);
    expect(summary.deletions).toBe(1);
  });

  it('counts only the latest cumulative diff of a file modified twice', () => {
    const grown = SIMPLE_DIFF + '\n+third line';
    const events = [
      event({ path: 'src/a.ts', diff: SIMPLE_DIFF }, 'e1'),
      event({ path: 'src/a.ts', diff: grown }, 'e2'),
    ];
    const summary = summarizeChanges(events);
    expect(summary.additions).toBe(3);
    expect(summary.deletions).toBe(1);
  });

  it('skips events without a path and preserves first-seen order', () => {
    const events = [
      event({ diff: SIMPLE_DIFF }, 'e1'),
      event({ path: 'z.ts', diff: CREATED_DIFF }, 'e2'),
      event({ path: 'a.ts', diff: CREATED_DIFF }, 'e3'),
    ];
    const summary = summarizeChanges(events);
    expect(summary.count).toBe(2);
    expect(summary.changes.map((c) => c.path)).toEqual(['z.ts', 'a.ts']);
  });

  it('returns an empty summary for no usable events', () => {
    expect(summarizeChanges([])).toEqual({ changes: [], count: 0, additions: 0, deletions: 0 });
  });
});
