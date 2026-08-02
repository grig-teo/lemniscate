import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toolBash, toolGrep, toolGlob, toolReadFile, toolWriteFile } from '../src/lib/lemcore/tools.js';
import { prepareEditContent } from '../src/lib/lemcore/edit-helpers.js';
import { executeTool } from '../src/lib/lemcore/loop-tool-runner.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-tools-'));
});

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(workdir, { recursive: true, force: true }));
});

describe('toolBash — non-zero exit is not a tool failure', () => {
  it('returns output without error when grep finds no matches (exit 1)', async () => {
    await writeFile(path.join(workdir, 'a.txt'), 'hello\nworld\n');
    const result = await toolBash(workdir, 'grep -q nonexistent a.txt');

    expect(result.tool).toBe('bash');
    expect(result.error).toBeUndefined();
  });

  it('returns output without error when ls targets a missing file (exit 1/2)', async () => {
    const result = await toolBash(workdir, 'ls nope.txt 2>&1');

    expect(result.error).toBeUndefined();
    expect(result.outputPreview).toContain('No such file or directory');
  });

  it('returns output without error for a failing test run (exit 1)', async () => {
    await writeFile(
      path.join(workdir, 'test.sh'),
      'echo "1 test, 1 failed"; exit 1',
    );
    const result = await toolBash(workdir, 'bash test.sh');

    expect(result.error).toBeUndefined();
    expect(result.outputPreview).toContain('1 test, 1 failed');
  });

  it('returns exit-1 output without error for a compound pipe ending in grep', async () => {
    await writeFile(path.join(workdir, 'a.txt'), 'foo\n');
    const result = await toolBash(workdir, 'cat a.txt | grep -q bar');

    expect(result.error).toBeUndefined();
  });
});

describe('toolGrep — no matches is not a tool failure', () => {
  it('returns "(no matches)" without error when ripgrep finds nothing', async () => {
    await writeFile(path.join(workdir, 'a.txt'), 'hello\n');
    const result = await toolGrep(workdir, 'nonexistent_pattern');

    expect(result.error).toBeUndefined();
    expect(result.outputPreview).toBe('(no matches)');
  });

  it('returns matches without error when pattern is found', async () => {
    await writeFile(path.join(workdir, 'a.txt'), 'hello world\n');
    const result = await toolGrep(workdir, 'hello');

    expect(result.error).toBeUndefined();
    expect(result.outputPreview).toContain('hello');
  });
});

describe('toolReadFile', () => {
  it('reads a file successfully', async () => {
    await writeFile(path.join(workdir, 'b.txt'), 'content here\n');
    const result = await toolReadFile(workdir, 'b.txt');

    expect(result.outputPreview).toContain('content here');
    expect(result.error).toBeUndefined();
  });
});

describe('toolGlob', () => {
  it('finds files matching a pattern', async () => {
    await writeFile(path.join(workdir, 'a.ts'), 'x');
    await writeFile(path.join(workdir, 'b.ts'), 'x');
    await writeFile(path.join(workdir, 'c.md'), 'x');

    const result = await toolGlob(workdir, '*.ts');

    expect(result.outputPreview).toContain('a.ts');
    expect(result.outputPreview).toContain('b.ts');
    expect(result.outputPreview).not.toContain('c.md');
  });
});

describe('file tools on a directory path — actionable error, not raw EISDIR', () => {
  it('toolReadFile rejects a directory with the relPath in the message', async () => {
    await mkdir(path.join(workdir, 'subdir'));
    await expect(toolReadFile(workdir, 'subdir')).rejects.toThrow(
      'read_file: "subdir" is a directory, not a file',
    );
  });

  it('prepareEditContent rejects a directory (edit_file/multi_edit path)', async () => {
    await mkdir(path.join(workdir, 'subdir'));
    await expect(prepareEditContent(workdir, 'subdir', (o) => o)).rejects.toThrow(
      'is a directory, not a file',
    );
  });

  it('prepareEditContent rejects an empty path (resolves to the workdir root)', async () => {
    await expect(prepareEditContent(workdir, '', (o) => o)).rejects.toThrow(
      'is a directory, not a file',
    );
  });

  it('toolWriteFile rejects writing over a directory', async () => {
    await mkdir(path.join(workdir, 'adir'));
    await expect(toolWriteFile(workdir, 'adir', 'x')).rejects.toThrow(
      'write_file: "adir" is a directory, not a file',
    );
  });
});

describe('executeTool file-path guard — empty/missing path never reaches fs', () => {
  it.each([
    ['edit_file', { path: '', search: 'a', replace: 'b' }],
    ['edit_file', { path: '   ', search: 'a', replace: 'b' }],
    ['edit_file', { search: 'a', replace: 'b' }],
    ['multi_edit', { path: '', edits: [{ search: 'a', replace: 'b' }] }],
    ['read_file', { path: '' }],
    ['write_file', { content: 'x' }],
  ])('%s with %o returns a ToolResult error, not a thrown EISDIR', async (name, args) => {
    const result = await executeTool(name, args, workdir, []);

    expect(result.error).toBeDefined();
    expect(result.error).not.toContain('EISDIR');
    expect(result.error).toContain(`${name}: a non-empty "path" argument is required`);
  });

  it('a real edit_file still works through the guard', async () => {
    await writeFile(path.join(workdir, 'ok.ts'), 'const a = 1;\n');
    const result = await executeTool(
      'edit_file', { path: 'ok.ts', search: 'a = 1', replace: 'a = 2' }, workdir, [],
    );

    expect(result.error).toBeUndefined();
    expect(result.outputPreview).toContain('edited ok.ts');
  });
});

describe('think tool', () => {
  it('echoes the thought back as the tool result (mid-loop scratchpad)', async () => {
    const result = await executeTool('think', { thought: 'I should check if tests pass before finishing.' }, workdir, []);

    expect(result.tool).toBe('think');
    expect(result.error).toBeUndefined();
    expect(result.outputPreview).toBe('I should check if tests pass before finishing.');
  });

  it('handles an empty thought gracefully', async () => {
    const result = await executeTool('think', {}, workdir, []);

    expect(result.tool).toBe('think');
    expect(result.error).toBeUndefined();
  });
});