import { describe, expect, it } from 'vitest';

import type { TaskImage } from '@/lib/hooks';
import {
  appendMarkdownToPrompt,
  buildStartTaskBody,
  buildTaskEditBody,
  taskAgentsMdInitial,
  taskMcpSelections,
  taskSkillSelections,
} from '@/lib/proposal-detail';
import { isPendingProposal } from '@/lib/repo-tasks';

// Tests for the proposal-detail pure helpers: the markdown-append rule for
// the attach row and the minimal start body (only changed fields + images).
// The pending-proposal predicate is covered in repo-tasks.test.ts; a smoke
// test here locks its use for the ConsolePane branch (SelectedTask shape).

describe('isPendingProposal (SelectedTask shape)', () => {
  it('accepts the selection shape with an optional kind', () => {
    expect(isPendingProposal({ kind: 'proposal', status: 'pending' })).toBe(true);
    expect(isPendingProposal({ status: 'pending' })).toBe(false);
  });
});

describe('appendMarkdownToPrompt', () => {
  it('appends markdown content after a blank line', () => {
    expect(appendMarkdownToPrompt('Fix the bug', '# Notes\ndetail')).toBe(
      'Fix the bug\n\n# Notes\ndetail',
    );
  });

  it('uses the content as-is when the prompt is empty', () => {
    expect(appendMarkdownToPrompt('   ', '# Notes')).toBe('# Notes');
  });

  it('trims the appended content', () => {
    expect(appendMarkdownToPrompt('Fix', '  notes \n')).toBe('Fix\n\nnotes');
  });
});

describe('buildStartTaskBody', () => {
  const task = { title: 'Old title', prompt: 'Old prompt' };
  const images: TaskImage[] = [{ name: 'a.png', dataUrl: 'data:image/png;base64,x' }];

  it('is empty when nothing changed and no images attached', () => {
    expect(
      buildStartTaskBody({ task, title: 'Old title', prompt: 'Old prompt', images: [] }),
    ).toEqual({});
  });

  it('includes only the edited prompt when the prompt changed', () => {
    expect(
      buildStartTaskBody({ task, title: 'Old title', prompt: 'New prompt', images: [] }),
    ).toEqual({ prompt: 'New prompt' });
  });

  it('includes only the edited title when the title changed', () => {
    expect(
      buildStartTaskBody({ task, title: 'New title', prompt: 'Old prompt', images: [] }),
    ).toEqual({ title: 'New title' });
  });

  it('includes images whenever any are attached', () => {
    expect(buildStartTaskBody({ task, title: 'Old title', prompt: 'Old prompt', images })).toEqual(
      { images },
    );
  });
});

describe('buildTaskEditBody', () => {
  const task = { title: 'T', prompt: 'P' };
  const selections = {
    skillSlugs: ['code-review'],
    mcpServerSlugs: ['fetch'],
    agentsMdFiles: [{ folder: '/', skillId: 's1' }],
  };

  it('always carries the full library selections', () => {
    const body = buildTaskEditBody({ task, title: 'T', prompt: 'P', images: [], selections });
    expect(body).toEqual({
      skills: ['code-review'],
      mcpServerSlugs: ['fetch'],
      agentsMdFiles: [{ folder: '/', skillId: 's1' }],
    });
  });

  it('includes title/prompt only when edited, images when attached', () => {
    const images: TaskImage[] = [{ name: 'a.png', dataUrl: 'data:image/png;base64,x' }];
    const body = buildTaskEditBody({ task, title: 'T2', prompt: 'P2', images, selections });
    expect(body.title).toBe('T2');
    expect(body.prompt).toBe('P2');
    expect(body.images).toEqual(images);
  });
});

describe('prefill helpers', () => {
  it('taskSkillSelections maps slugs to names, falling back to the slug', () => {
    const map = taskSkillSelections(['a', 'b'], [{ slug: 'a', name: 'Alpha' }]);
    expect(map.get('a')).toBe('Alpha');
    expect(map.get('b')).toBe('b');
    expect(taskSkillSelections(null, []).size).toBe(0);
  });

  it('taskMcpSelections uses the stored map keys', () => {
    const map = taskMcpSelections({ fetch: { command: 'uvx' } });
    expect(map.get('fetch')).toBe('fetch');
    expect(taskMcpSelections(undefined).size).toBe(0);
  });

  it('taskAgentsMdInitial turns stored files into saved-file assignments', () => {
    const initial = taskAgentsMdInitial([
      { folder: '/src', content: '# API\n' },
      { folder: 42 },
      'garbage',
    ]);
    expect(initial).toHaveLength(1);
    expect(initial[0].folder).toBe('/src');
    expect(initial[0].value.upload?.content).toBe('# API\n');
  });
});
