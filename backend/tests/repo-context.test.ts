import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFileTree,
  buildRepoContext,
  contextBudgetChars,
  isKeyFile,
  truncateKeyFile,
} from '../src/lib/repo-context.js';

// Locking tests for the repo-context builders extracted from agent-loop.ts:
// the file-tree walker (skip dirs / lockfiles / binary extensions), the key
// file heuristic, and the context-window budgeting.

describe('contextBudgetChars', () => {
  it('is half the context window converted to chars (tokens * 4 * 0.5)', () => {
    expect(contextBudgetChars(100_000)).toBe(200_000);
  });

  it('has a floor of 4000 chars', () => {
    expect(contextBudgetChars(1_000)).toBe(4_000);
    expect(contextBudgetChars(0)).toBe(4_000);
  });
});

describe('isKeyFile', () => {
  it('matches README files at depth <= 1', () => {
    expect(isKeyFile('README.md')).toBe(true);
    expect(isKeyFile('docs/README')).toBe(true);
    expect(isKeyFile('a/b/README.md')).toBe(false);
  });

  it('matches manifest basenames at depth <= 2', () => {
    expect(isKeyFile('package.json')).toBe(true);
    expect(isKeyFile('a/b/Cargo.toml')).toBe(true);
    expect(isKeyFile('a/b/c/package.json')).toBe(false);
  });

  it('matches common entry points', () => {
    expect(isKeyFile('src/index.ts')).toBe(true);
    expect(isKeyFile('main.go')).toBe(true);
    expect(isKeyFile('src/lib/index.ts')).toBe(false);
  });

  it('matches Go cmd entry points', () => {
    expect(isKeyFile('cmd/server/main.go')).toBe(true);
    expect(isKeyFile('cmd/a/b/main.go')).toBe(false);
  });

  it('rejects ordinary source files', () => {
    expect(isKeyFile('src/lib/util.ts')).toBe(false);
  });
});

describe('truncateKeyFile', () => {
  it('returns content within budget unchanged', () => {
    expect(truncateKeyFile('short', 100)).toBe('short');
  });

  it('truncates with the marker appended', () => {
    expect(truncateKeyFile('abcdefgh', 3)).toBe('abc\n… [truncated]');
  });
});

describe('file tree + repo context (on a real temp repo)', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'lemniscate-ctx-'));
    await mkdir(path.join(workdir, 'src'), { recursive: true });
    await mkdir(path.join(workdir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(workdir, 'package.json'), '{"name":"demo"}');
    await writeFile(path.join(workdir, 'README.md'), '# demo');
    await writeFile(path.join(workdir, 'src', 'index.ts'), 'console.log(1)');
    await writeFile(path.join(workdir, 'src', 'util.ts'), 'export const x = 1;');
    await writeFile(path.join(workdir, 'package-lock.json'), '{}');
    await writeFile(path.join(workdir, 'logo.png'), 'not really png');
    await writeFile(path.join(workdir, 'node_modules', 'pkg', 'index.js'), 'x');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('buildFileTree skips dependency dirs, lockfiles, and binary files, sorted', async () => {
    const tree = await buildFileTree(workdir);
    expect(tree).toEqual(['package.json', 'README.md', 'src/index.ts', 'src/util.ts']);
  });

  it('buildRepoContext includes the tree header and key file contents only', async () => {
    const context = await buildRepoContext(workdir, 100_000);
    expect(context).toContain('## File tree (4 files)');
    expect(context).toContain('## File: package.json');
    expect(context).toContain('{"name":"demo"}');
    expect(context).toContain('## File: README.md');
    expect(context).toContain('## File: src/index.ts');
    // src/util.ts is listed in the tree but is not a key file.
    expect(context).toContain('src/util.ts');
    expect(context).not.toContain('## File: src/util.ts');
    expect(context).not.toContain('export const x = 1;');
  });
});
