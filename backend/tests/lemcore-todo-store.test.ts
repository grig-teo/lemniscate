import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTodoItems, toolTodoWrite, getTodoList } from '../src/lib/lemcore/todo-store.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-todo-'));
});

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(workdir, { recursive: true, force: true }));
});

describe('parseTodoItems', () => {
  it('parses markdown checkboxes into done/pending items', () => {
    const items = parseTodoItems([
      '- [x] Set up the project',
      '- [ ] Write tests',
      '- [ ] Deploy',
    ].join('\n'));
    expect(items).toEqual([
      { done: true, text: 'Set up the project' },
      { done: false, text: 'Write tests' },
      { done: false, text: 'Deploy' },
    ]);
  });

  it('parses unchecked checkboxes', () => {
    const items = parseTodoItems('- [ ] Implement feature X');
    expect(items).toEqual([{ done: false, text: 'Implement feature X' }]);
  });

  it('treats plain lines (no checkbox) as pending items', () => {
    const items = parseTodoItems('Do thing one\nDo thing two');
    expect(items).toEqual([
      { done: false, text: 'Do thing one' },
      { done: false, text: 'Do thing two' },
    ]);
  });

  it('skips blank lines', () => {
    const items = parseTodoItems('- [x] Done\n\n\n- [ ] Next');
    expect(items).toHaveLength(2);
  });

  it('handles asterisk bullets', () => {
    const items = parseTodoItems('* [x] Done\n* [ ] Pending');
    expect(items).toEqual([
      { done: true, text: 'Done' },
      { done: false, text: 'Pending' },
    ]);
  });

  it('returns empty for empty/whitespace input', () => {
    expect(parseTodoItems('')).toEqual([]);
    expect(parseTodoItems('   \n  ')).toEqual([]);
  });
});

describe('toolTodoWrite — emits subtype for the panel', () => {
  it('returns a todo_write result whose detail is the parsed items JSON', () => {
    const result = toolTodoWrite(workdir, '- [x] Done\n- [ ] Next', []);
    expect(result.tool).toBe('todo_write');
    expect(result.detail).toBeDefined();
    const parsed = JSON.parse(result.detail!);
    expect(parsed).toEqual([
      { done: true, text: 'Done' },
      { done: false, text: 'Next' },
    ]);
  });

  it('stores the raw list so loop.ts can re-inject it', () => {
    toolTodoWrite(workdir, '- [ ] Task A', []);
    expect(getTodoList(workdir)).toBe('- [ ] Task A');
  });
});
