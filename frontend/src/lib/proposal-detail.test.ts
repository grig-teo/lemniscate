import { describe, expect, it } from 'vitest';

import type { TaskImage } from '@/lib/hooks';
import {
  appendMarkdownToPrompt,
  buildStartTaskBody,
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
