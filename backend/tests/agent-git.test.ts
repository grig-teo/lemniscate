import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publishTaskEvent: vi.fn(),
  archiveWorkdirToMinio: vi.fn(),
  notifyTaskFailure: vi.fn(),
  notifyJobFailure: vi.fn(),
}));

vi.mock('../src/lib/task-events.js', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}));

vi.mock('../src/lib/workdir-archive.js', () => ({
  archiveWorkdirToMinio: mocks.archiveWorkdirToMinio,
}));

vi.mock('../src/lib/notifications.js', () => ({
  notifyTaskFailure: mocks.notifyTaskFailure,
  // logJobFailure (job-failure-log.ts) fans every failure out here; the
  // fan-out itself is covered in notification-delivery.test.ts.
  notifyJobFailure: mocks.notifyJobFailure,
}));

import { cleanupWorkdir, cloneRepository, explainGitFailure, git, planWorkdirSweep, recordJobFailure, sanitizeRelativePath } from '../src/lib/agent-git.js';

// Locking tests for the LLM-path safety check extracted from agent-loop.ts,
// plus the git() console logging: every command echoes a redacted
// `$ git ...` line to the task's event stream when a taskId is available.

beforeEach(() => {
  vi.clearAllMocks();
  mocks.publishTaskEvent.mockResolvedValue(undefined);
  mocks.notifyTaskFailure.mockResolvedValue(undefined);
  mocks.notifyJobFailure.mockResolvedValue(undefined);
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

describe('cleanupWorkdir', () => {
  async function makeWorkdir(): Promise<{ tmp: string; workdir: string }> {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-'));
    const workdir = path.join(tmp, 'task-1');
    await fs.mkdir(workdir, { recursive: true });
    return { tmp, workdir };
  }

  it('archives the workdir to MinIO before removing it, then logs the cleanup', async () => {
    const fs = await import('node:fs/promises');
    const { tmp, workdir } = await makeWorkdir();
    try {
      let existedWhenArchived = false;
      mocks.archiveWorkdirToMinio.mockImplementation(async () => {
        existedWhenArchived = await fs.stat(workdir).then((s) => s.isDirectory()).catch(() => false);
      });
      await cleanupWorkdir(workdir, 'task-1');
      expect(mocks.archiveWorkdirToMinio).toHaveBeenCalledWith(workdir);
      expect(existedWhenArchived).toBe(true);
      await expect(fs.stat(workdir)).rejects.toThrow();
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'log', {
        line: 'cleaned up workdir',
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('still removes the workdir when the archive step throws', async () => {
    const fs = await import('node:fs/promises');
    const { tmp, workdir } = await makeWorkdir();
    try {
      mocks.archiveWorkdirToMinio.mockRejectedValue(new Error('minio down'));
      await expect(cleanupWorkdir(workdir, 'task-1')).resolves.toBeUndefined();
      await expect(fs.stat(workdir)).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('writes nothing to the task console about the archive itself', async () => {
    const fs = await import('node:fs/promises');
    const { tmp, workdir } = await makeWorkdir();
    try {
      mocks.archiveWorkdirToMinio.mockResolvedValue(undefined);
      await cleanupWorkdir(workdir, 'task-1');
      const lines = mocks.publishTaskEvent.mock.calls.map((c) => c[2]?.line as string);
      expect(lines).toEqual(['cleaned up workdir']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('recordJobFailure', () => {
  it('funnels the failure through logJobFailure only (single notification path)', async () => {
    const err = new Error('boom');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const message = await recordJobFailure('run-task', 'task-1', err, []);
      expect(message).toBe('boom');
      // logJobFailure fans out to notifyJobFailure; recordJobFailure must NOT
      // also call notifyTaskFailure directly — the two concurrent flows race
      // the unread dedupe and produce duplicate notifications/deliveries.
      expect(mocks.notifyJobFailure).toHaveBeenCalledTimes(1);
      expect(mocks.notifyJobFailure).toHaveBeenCalledWith({
        jobName: 'run-task',
        taskId: 'task-1',
        errorKind: 'Error',
        message: 'boom',
      });
      expect(mocks.notifyTaskFailure).not.toHaveBeenCalled();
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'log', {
        line: 'error: boom',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('awaits the notification funnel so a rethrown job cannot race the dedupe', async () => {
    // review-pr/merge-gate rethrow after recordJobFailure; the worker 'failed'
    // hook then funnels the same throw through logJobFailure again. The in-run
    // notification must have landed BEFORE recordJobFailure returns, or both
    // flows pass the findFirst-then-insert dedupe concurrently.
    let resolveHook: (() => void) | undefined;
    mocks.notifyJobFailure.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveHook = resolve;
        }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let settled = false;
      const pending = recordJobFailure('review-pr', 'task-1', new Error('boom'), []).then((m) => {
        settled = true;
        return m;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      resolveHook?.();
      await expect(pending).resolves.toBe('boom');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('still returns the message when the notification itself fails', async () => {
    mocks.notifyJobFailure.mockRejectedValueOnce(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(recordJobFailure('run-task', 'task-1', new Error('boom'), [])).resolves.toBe('boom');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('explainGitFailure', () => {
  it('appends a reconnect hint to the GitHub workflow-scope rejection', () => {
    const stderr =
      'git push failed: ! [remote rejected] x -> x (refusing to allow an OAuth App ' +
      'to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)';
    const explained = explainGitFailure(stderr);
    expect(explained).toContain("'workflow' OAuth scope");
    expect(explained).toContain('reconnect the GitHub connection');
  });

  it('leaves unrelated errors untouched', () => {
    expect(explainGitFailure('git push failed: 403 forbidden')).toBe(
      'git push failed: 403 forbidden',
    );
  });
});
