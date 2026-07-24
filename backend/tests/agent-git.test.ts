import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ publishTaskEvent: vi.fn() }));

vi.mock('../src/lib/task-events.js', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}));

import { cloneRepository, git, planWorkdirSweep, sanitizeRelativePath } from '../src/lib/agent-git.js';

// Locking tests for the LLM-path safety check extracted from agent-loop.ts,
// plus the git() console logging: every command echoes a redacted
// `$ git ...` line to the task's event stream when a taskId is available.

beforeEach(() => {
  vi.clearAllMocks();
  mocks.publishTaskEvent.mockResolvedValue(undefined);
});

describe('sanitizeRelativePath', () => {
  it('normalizes ordinary relative paths', () => {
    expect(sanitizeRelativePath('src/a.ts')).toBe('src/a.ts');
    expect(sanitizeRelativePath('a/./b')).toBe('a/b');
  });

  it('converts backslashes to forward slashes', () => {
    expect(sanitizeRelativePath('src\\a.ts')).toBe('src/a.ts');
  });

  it.each(['/abs/path', '..', '../escape', 'a/../../b', '.', '.git', '.git/config'])(
    'rejects unsafe path %s',
    (raw) => {
      expect(() => sanitizeRelativePath(raw)).toThrow(`LLM proposed an unsafe file path: ${raw}`);
    },
  );
});

describe('git() console logging', () => {
  it('emits a `$ git ...` log event when a taskId is available', async () => {
    await git(['--version'], { taskId: 'task-1' });
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'log', {
      line: '$ git --version',
    });
  });

  it('stays silent without a taskId', async () => {
    await git(['--version']);
    expect(mocks.publishTaskEvent).not.toHaveBeenCalled();
  });

  it('redacts secrets (credentialed URLs) from the logged command', async () => {
    const url = 'https://x:super-secret-token@example.com/repo.git';
    await expect(
      git(['clone', url, '/nonexistent-dir'], { taskId: 'task-1', secrets: [url] }),
    ).rejects.toThrow();
    const line = mocks.publishTaskEvent.mock.calls[0]?.[2].line as string;
    expect(line).toBe('$ git clone [redacted] /nonexistent-dir');
    expect(line).not.toContain('super-secret-token');
  });
});

describe('planWorkdirSweep', () => {
  it('keeps the workdirs of queued/running tasks', () => {
    const active = new Set(['task-1']);
    expect(planWorkdirSweep(['task-1', 'task-2'], active)).toEqual(['task-2']);
  });

  it('keeps review workdirs whose task is active', () => {
    const active = new Set(['task-1']);
    expect(planWorkdirSweep(['review-task-1-0', 'review-task-2-1'], active)).toEqual([
      'review-task-2-1',
    ]);
  });

  it('sweeps proposals/folders leftovers and unknown directories', () => {
    const active = new Set(['task-1']);
    expect(
      planWorkdirSweep(['proposals-repo-1', 'folders-repo-1-abc', 'stray'], active),
    ).toEqual(['proposals-repo-1', 'folders-repo-1-abc', 'stray']);
  });

  it('sweeps everything when no task is active', () => {
    expect(planWorkdirSweep(['task-9', 'review-task-9-0'], new Set())).toEqual([
      'task-9',
      'review-task-9-0',
    ]);
  });
});

describe('cloneRepository empty-repo fallback', () => {
  it('inits a fresh repo when the remote has no branches', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-empty-'));
    try {
      const remote = path.join(tmp, 'remote.git');
      await git(['init', '--bare', remote]);
      const workdir = path.join(tmp, 'work');
      const result = await cloneRepository(workdir, remote, 'master', []);
      expect(result.emptyRepo).toBe(true);
      const branch = await git(['branch', '--show-current'], { cwd: workdir });
      expect(branch.trim()).toBe('master');
      const origin = await git(['remote', 'get-url', 'origin'], { cwd: workdir });
      expect(origin.trim()).toBe(remote);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('clones normally when the remote has the branch', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-normal-'));
    try {
      const seed = path.join(tmp, 'seed');
      await git(['init', '-b', 'main', seed]);
      await git(['config', 'user.email', 't@t'], { cwd: seed });
      await git(['config', 'user.name', 't'], { cwd: seed });
      await fs.writeFile(path.join(seed, 'a.txt'), 'a');
      await git(['add', '.'], { cwd: seed });
      await git(['commit', '-m', 'init'], { cwd: seed });
      const result = await cloneRepository(path.join(tmp, 'work'), seed, 'main', []);
      expect(result.emptyRepo).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps the origin URL tokenless when auth is supplied', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-tokenless-'));
    try {
      const remote = path.join(tmp, 'remote.git');
      await git(['init', '--bare', remote]);
      const workdir = path.join(tmp, 'work');
      const result = await cloneRepository(workdir, remote, 'master', ['s3cret-token'], {
        auth: { username: 'oauth2', token: 's3cret-token' },
      });
      expect(result.emptyRepo).toBe(true);
      const origin = await git(['remote', 'get-url', 'origin'], { cwd: workdir });
      expect(origin.trim()).toBe(remote);
      expect(origin).not.toContain('s3cret-token');
      const gitConfig = await fs.readFile(path.join(workdir, '.git', 'config'), 'utf8');
      expect(gitConfig).not.toContain('s3cret-token');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
