import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ publishTaskEvent: vi.fn() }));

vi.mock('../src/lib/task-events.js', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}));

import { git, sanitizeRelativePath } from '../src/lib/agent-git.js';

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
