import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toolBash, toolGrep, toolGlob, toolReadFile } from '../src/lib/lemcore/tools.js';
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