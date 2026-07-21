import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), logEvent: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));

import { runHermesTask, type HermesTaskOptions } from '../src/lib/hermes-runner.js';

// Tests for the Hermes CLI task executor: isolated HERMES_HOME config,
// non-interactive spawn, line streaming with ANSI stripping + secret
// redaction, timeout kill, and exit-code handling.

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

let workdir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.logEvent.mockResolvedValue(undefined);
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-runner-test-'));
  await fs.mkdir(path.join(workdir, '.git', 'info'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

function makeOpts(overrides: Partial<HermesTaskOptions> = {}): HermesTaskOptions {
  return {
    workdir,
    prompt: 'do the thing',
    llm: {
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-test',
      model: 'model-x',
      contextWindow: 128_000,
    },
    taskId: 'task-1',
    secrets: ['topsecret'],
    timeoutMs: 5_000,
    ...overrides,
  };
}

// Ends both streams, waits for the line handlers to flush, then emits close.
async function closeWith(child: FakeChild, code: number): Promise<void> {
  child.stdout.end();
  child.stderr.end();
  await new Promise((resolve) => setTimeout(resolve, 10));
  child.emit('close', code);
}

function loggedLines(): string[] {
  return mocks.logEvent.mock.calls.map((call) => call[1] as string);
}

describe('runHermesTask', () => {
  it('writes an isolated HERMES_HOME config.yaml from the llm fields', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts());
    await closeWith(child, 0);
    await promise;

    const yaml = await fs.readFile(path.join(workdir, '.hermes-home', 'config.yaml'), 'utf8');
    expect(yaml).toBe(
      [
        'model:',
        '  default: model-x',
        '  provider: custom',
        '  base_url: https://llm.example/v1',
        '  api_key: sk-test',
        '  context_length: 128000',
        '',
      ].join('\n'),
    );
  });

  it('excludes .hermes-home/ from git via .git/info/exclude', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts());
    await closeWith(child, 0);
    await promise;

    const exclude = await fs.readFile(path.join(workdir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.hermes-home/');
  });

  it('spawns `hermes chat -q <prompt>` without a shell, with yolo env', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts({ prompt: 'weird "prompt" $(rm -rf) `x`' }));
    await closeWith(child, 0);
    await promise;

    expect(mocks.spawn).toHaveBeenCalledWith(
      'hermes',
      ['chat', '-q', 'weird "prompt" $(rm -rf) `x`'],
      expect.objectContaining({ cwd: workdir }),
    );
    const env = mocks.spawn.mock.calls[0]?.[2].env as Record<string, string>;
    expect(env.HERMES_HOME).toBe(path.join(workdir, '.hermes-home'));
    expect(env.HERMES_YOLO_MODE).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('streams stdout and stderr lines to the task console', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts());
    child.stdout.write('first line\n');
    child.stderr.write('second line\n');
    await closeWith(child, 0);
    await promise;

    expect(loggedLines()).toEqual(expect.arrayContaining(['first line', 'second line']));
    for (const call of mocks.logEvent.mock.calls) expect(call[0]).toBe('task-1');
  });

  it('strips ANSI escape codes from streamed lines', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts());
    child.stdout.write('\u001b[32mgreen text\u001b[0m\n');
    await closeWith(child, 0);
    await promise;

    expect(loggedLines()).toContain('green text');
  });

  it('redacts secrets from streamed lines', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts());
    child.stdout.write('the token is topsecret ok\n');
    await closeWith(child, 0);
    await promise;

    expect(loggedLines()).toContain('the token is [redacted] ok');
  });

  it('rejects on a nonzero exit code with the output tail', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts());
    child.stdout.write(`${'x'.repeat(600)}\n`);
    child.stdout.write('boom failure\n');
    await closeWith(child, 1);
    const err = await promise.then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('boom failure');
    expect(err?.message).not.toContain('x'.repeat(600));
  });

  it('kills the process and rejects on timeout', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts({ timeoutMs: 20 }));
    const err = await promise.then(
      () => null,
      (e: Error) => e,
    );

    expect(child.kill).toHaveBeenCalled();
    expect(err?.message).toMatch(/timed out/);
  });

  it('rejects with a clear message when the hermes binary is missing', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts());
    // The runner spawns after writing HERMES_HOME; wait for the listeners.
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    child.emit('error', Object.assign(new Error('spawn hermes ENOENT'), { code: 'ENOENT' }));

    await expect(promise).rejects.toThrow('hermes CLI not installed in the worker image');
  });
});
