import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Mock multi-sample so runEdit's ctx path is deterministic and fast.
const verifyEditMock = vi.fn();
vi.mock('../src/lib/lemcore/multi-sample.js', () => ({
  verifyEditWithFallback: (...args: unknown[]) => verifyEditMock(...args),
}));

import { runEdit } from '../src/lib/lemcore/edit-router.js';
import { prepareEditContent, toolWriteFile } from '../src/lib/lemcore/tools.js';
import { getCheckpoint } from '../src/lib/lemcore/edit-checkpoint.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-edit-'));
  verifyEditMock.mockReset();
});

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(workdir, { recursive: true, force: true }));
  vi.clearAllMocks();
});

function fakeCtx() {
  return {
    rt: { cfg: {} } as never,
    taskId: 't1',
    toolCall: { id: 'c1', type: 'function', function: { name: 'edit_file', arguments: '{}' } } as never,
  };
}

describe('prepareEditContent', () => {
  it('reads the file, applies the transform, and checkpoints the original', async () => {
    await writeFile(path.join(workdir, 'a.ts'), 'const x = 1;\n');
    const { originalContent, newContent } = await prepareEditContent(
      workdir, 'a.ts', (o) => o.replace('x = 1', 'x = 2'),
    );
    expect(originalContent).toBe('const x = 1;\n');
    expect(newContent).toBe('const x = 2;\n');
    // Checkpoint stored for undo_edit.
    expect(getCheckpoint(workdir, 'a.ts')).toBe('const x = 1;\n');
  });

  it('does NOT write the file (the caller owns the write)', async () => {
    await writeFile(path.join(workdir, 'b.ts'), 'original\n');
    await prepareEditContent(workdir, 'b.ts', () => 'changed\n');
    // File untouched — only the checkpoint captured the original.
    expect(await readFile(path.join(workdir, 'b.ts'), 'utf8')).toBe('original\n');
  });

  it('propagates validation errors from the compute callback', async () => {
    await writeFile(path.join(workdir, 'c.ts'), 'const y = 1;\n');
    await expect(
      prepareEditContent(workdir, 'c.ts', () => { throw new Error('search not found'); }),
    ).rejects.toThrow('search not found');
  });
});

describe('runEdit routing', () => {
  it('routes through verifyEditWithFallback when ctx is present', async () => {
    verifyEditMock.mockResolvedValue({ tool: 'edit_file', title: 'a.ts', outputPreview: 'ok', durationMs: 3 });
    await writeFile(path.join(workdir, 'a.ts'), 'const x = 1;\n');

    const result = await runEdit(
      'edit_file', 'a.ts', workdir, [], fakeCtx(),
      (o) => o.replace('x = 1', 'x = 2'),
    );

    expect(verifyEditMock).toHaveBeenCalledTimes(1);
    const passed = verifyEditMock.mock.calls[0]![0] as { primaryNewContent: string; originalContent: string };
    expect(passed.originalContent).toBe('const x = 1;\n');
    expect(passed.primaryNewContent).toBe('const x = 2;\n');
    expect(result.outputPreview).toBe('ok');
  });

  it('falls back to plain lint-gate when ctx is absent', async () => {
    await writeFile(path.join(workdir, 'b.ts'), 'const x = 1;\n');

    const result = await runEdit(
      'edit_file', 'b.ts', workdir, [], undefined,
      (o) => o.replace('x = 1', 'x = 2'),
    );

    expect(verifyEditMock).not.toHaveBeenCalled();
    // No lint config → accepted, file written.
    expect(result.error).toBeUndefined();
    expect(await readFile(path.join(workdir, 'b.ts'), 'utf8')).toBe('const x = 2;\n');
    // Show-details diff payload: unified diff of the edit.
    expect(result.diff).toContain('--- a/b.ts');
    expect(result.diff).toContain('+++ b/b.ts');
    expect(result.diff).toContain('-const x = 1;');
    expect(result.diff).toContain('+const x = 2;');
  });

  it('propagates compute validation errors before any write', async () => {
    await writeFile(path.join(workdir, 'c.ts'), 'const x = 1;\n');
    await expect(
      runEdit('edit_file', 'c.ts', workdir, [], fakeCtx(), () => {
        throw new Error('bad edit');
      }),
    ).rejects.toThrow('bad edit');
  });
});
describe('toolWriteFile diff payload', () => {
  it('marks a brand-new file as created (diff from /dev/null)', async () => {
    const result = await toolWriteFile(workdir, 'fresh.ts', 'export const n = 1;\n');
    expect(result.diff).toContain('--- /dev/null');
    expect(result.diff).toContain('+++ b/fresh.ts');
    expect(result.diff).toContain('+export const n = 1;');
  });

  it('diffs an overwrite against the previous content', async () => {
    await writeFile(path.join(workdir, 'over.ts'), 'old line\nkeep\n');
    const result = await toolWriteFile(workdir, 'over.ts', 'new line\nkeep\n');
    expect(result.diff).toContain('--- a/over.ts');
    expect(result.diff).toContain('+++ b/over.ts');
    expect(result.diff).toContain('-old line');
    expect(result.diff).toContain('+new line');
  });
});
