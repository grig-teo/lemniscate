import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface GitCall {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
}

const mocks = vi.hoisted(() => ({ calls: [] as GitCall[] }));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = vi.fn();
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    mocks.calls.push({ cmd, args, opts });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { execFile };
});

vi.mock('../src/lib/task-events.js', () => ({ publishTaskEvent: vi.fn() }));

import { cloneRepository, git } from '../src/lib/agent-git.js';

// Tokenless-origin hardening: credentials must travel via an inline git
// credential helper that reads the token from the child process env —
// never embedded in the origin URL (.git/config is readable by the YOLO
// agent) and never as a plaintext argv element (visible in `ps`).

const auth = { username: 'oauth2', token: 's3cret-token' };

function envOf(call: GitCall): Record<string, string | undefined> {
  return (call.opts as { env?: Record<string, string | undefined> }).env ?? {};
}

beforeEach(() => {
  mocks.calls.length = 0;
});

describe('git() credential auth', () => {
  it('authenticates push via a credential helper reading an env var', async () => {
    await git(['push', 'origin', 'main'], { cwd: '/tmp/x', auth });
    const call = mocks.calls[0];
    expect(call.args.join(' ')).not.toContain('s3cret-token');
    const helper = call.args.find((arg) => arg.startsWith('credential.helper=!'));
    expect(helper).toBeDefined();
    expect(helper).toContain('LEMNISCATE_GIT_TOKEN');
    expect(helper).toContain('oauth2');
    expect(envOf(call).LEMNISCATE_GIT_TOKEN).toBe('s3cret-token');
  });

  it('clears any configured credential helper before installing ours', async () => {
    await git(['fetch', 'origin'], { cwd: '/tmp/x', auth });
    const call = mocks.calls[0];
    expect(call.args).toContain('credential.helper=');
  });

  it('omits credential args and env when no auth is given', async () => {
    await git(['status'], { cwd: '/tmp/x' });
    const call = mocks.calls[0];
    expect(call.args.some((arg) => arg.startsWith('credential.helper'))).toBe(false);
    expect((call.opts as { env?: unknown }).env).toBeUndefined();
  });
});

describe('cloneRepository with auth', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-auth-'));
  });

  it('clones the tokenless URL with credentials only in the child env', async () => {
    const workdir = path.join(tmp, 'work');
    await cloneRepository(workdir, 'https://github.com/acme/repo.git', 'main', ['s3cret-token'], {
      auth,
    });
    const clone = mocks.calls.find((call) => call.args.includes('clone'));
    expect(clone).toBeDefined();
    expect(clone?.args).toContain('https://github.com/acme/repo.git');
    expect(clone?.args.join(' ')).not.toContain('s3cret-token');
    expect(envOf(clone as GitCall).LEMNISCATE_GIT_TOKEN).toBe('s3cret-token');
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
