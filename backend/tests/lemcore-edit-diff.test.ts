import { describe, expect, it } from 'vitest';

import {
  buildEditDiff,
  DIFF_MAX_INPUT_CHARS,
  DIFF_MAX_OUTPUT_CHARS,
} from '../src/lib/lemcore/edit-diff.js';

describe('buildEditDiff', () => {
  it('marks a brand-new file as created with every line added', () => {
    const diff = buildEditDiff({
      relPath: 'src/new.ts',
      oldContent: null,
      newContent: 'export const a = 1;\nexport const b = 2;\n',
    });
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/src/new.ts');
    expect(diff).toContain('+export const a = 1;');
    expect(diff).toContain('+export const b = 2;');
  });

  it('produces a unified diff for modified content', () => {
    const diff = buildEditDiff({
      relPath: 'src/app.ts',
      oldContent: 'one\ntwo\nthree\n',
      newContent: 'one\nTWO\nthree\nfour\n',
    });
    expect(diff).toContain('--- a/src/app.ts');
    expect(diff).toContain('+++ b/src/app.ts');
    expect(diff).toContain('@@');
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
    expect(diff).toContain('+four');
    expect(diff).toContain(' one');
  });

  it('labels identical content as unchanged (no phantom diff)', () => {
    const diff = buildEditDiff({
      relPath: 'same.ts',
      oldContent: 'x\n',
      newContent: 'x\n',
    });
    expect(diff).toContain('no changes');
  });

  it('announces large files instead of computing a multi-MB diff', () => {
    const huge = 'x'.repeat(DIFF_MAX_INPUT_CHARS + 1);
    const diff = buildEditDiff({ relPath: 'big.ts', oldContent: '', newContent: huge });
    expect(diff).toContain('diff not available');
    expect(diff).toContain('big.ts');
  });

  it('announces non-text content instead of a garbage diff', () => {
    const binary = 'PK' + String.fromCharCode(0) + 'rest';
    const diff = buildEditDiff({ relPath: 'a.zip', oldContent: null, newContent: binary });
    expect(diff).toContain('binary file changed');
    expect(diff).toContain('a.zip');
  });

  it('truncates very large diffs with a marker', () => {
    const line = '+' + 'y'.repeat(200) + '\n';
    const newContent = line.repeat(Math.ceil((DIFF_MAX_OUTPUT_CHARS + 1) / line.length));
    const diff = buildEditDiff({ relPath: 'huge-diff.ts', oldContent: null, newContent });
    expect(diff!.length).toBeLessThanOrEqual(DIFF_MAX_OUTPUT_CHARS + 100);
    expect(diff).toContain('truncated');
  });
});
