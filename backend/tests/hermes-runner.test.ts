import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), logBatch: vi.fn(), taskFindUnique: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/lib/agent-git.js', () => ({ logBatch: mocks.logBatch }));
vi.mock('../src/lib/prisma.js', () => ({ prisma: { task: { findUnique: mocks.taskFindUnique } } }));

import {
  hermesConfigYaml,
  runHermesTask,
  type HermesLlmConfig,
  type HermesTaskOptions,
} from '../src/lib/hermes-runner.js';

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
  mocks.logBatch.mockResolvedValue(undefined);
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
  // Wait until the runner has spawned: it writes HERMES_HOME (async fs)
  // before attaching its close/error listeners, and under CI/parallel load
  // that can outlast the flush delay below — a 'close' emitted before the
  // listener exists is lost and the test hangs until timeout.
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  child.stdout.end();
  child.stderr.end();
  await new Promise((resolve) => setTimeout(resolve, 10));
  child.emit('close', code);
}

function loggedLines(): string[] {
  return mocks.logBatch.mock.calls.flatMap((call) => call[1] as string[]);
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
        '  default: "model-x"',
        '  provider: custom',
        '  api_mode: chat_completions',
        '  base_url: "https://llm.example/v1"',
        '  api_key: "sk-test"',
        '  context_length: 128000',
        '',
      ].join('\n'),
    );
  });

  it('rejects when hermes reports an initialization failure despite exiting 0', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts());
    child.stdout.write('Failed to initialize agent: boom\n');
    await closeWith(child, 0);
    await expect(promise).rejects.toThrow('Failed to initialize agent');
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
    for (const call of mocks.logBatch.mock.calls) expect(call[0]).toBe('task-1');
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

describe('runHermesTask without a taskId', () => {
  it('streams nothing to the console and skips the cancel poll', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts({ taskId: undefined, pollMs: 20 }));
    child.stdout.write('orphan line\n');
    await closeWith(child, 0);
    await promise;

    expect(mocks.logBatch).not.toHaveBeenCalled();
    expect(mocks.taskFindUnique).not.toHaveBeenCalled();
  });

  it('still fails with the output tail on a nonzero exit', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts({ taskId: undefined }));
    child.stdout.write('boom failure\n');
    await closeWith(child, 1);

    await expect(promise).rejects.toThrow('boom failure');
    expect(mocks.logBatch).not.toHaveBeenCalled();
  });
});

describe('runHermesTask stall watchdog', () => {
  it('kills the process and rejects when output stays silent past the stall window', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts({ timeoutMs: 60_000, stallTimeoutMs: 30 }));
    const err = await promise.then(
      () => null,
      (e: Error) => e,
    );

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(err?.message).toMatch(/hermes agent stalled: no output for \d+s/);
    expect(err?.message).toContain('likely a hung LLM provider');
  });

  it('fails fast on silence even when the stall window is far below the hard timeout', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const startedMs = Date.now();
    const promise = runHermesTask(makeOpts({ timeoutMs: 60_000, stallTimeoutMs: 40 }));
    const err = await promise.then(
      () => null,
      (e: Error) => e,
    );

    expect(err?.message).toMatch(/stalled/);
    expect(Date.now() - startedMs).toBeLessThan(5_000);
  });

  it('resets the stall window on stdout/stderr activity', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = runHermesTask(makeOpts({ timeoutMs: 60_000, stallTimeoutMs: 60 }));
    // Keep pinging output inside the window: a naive total-runtime timer
    // would fire; the watchdog must re-arm on every line.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      child.stdout.write(`progress ${i}\n`);
    }
    // Still inside the re-armed window from the last line: no kill.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.kill).not.toHaveBeenCalled();

    await closeWith(child, 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('is disabled when stallTimeoutMs is unset or 0', async () => {
    for (const stallTimeoutMs of [undefined, 0]) {
      const child = fakeChild();
      mocks.spawn.mockReturnValue(child);
      const promise = runHermesTask(makeOpts({ timeoutMs: 5_000, stallTimeoutMs }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(child.kill).not.toHaveBeenCalled();
      await closeWith(child, 0);
      await expect(promise).resolves.toBeUndefined();
    }
  });
});

describe('buildHermesEnv', () => {
  it('builds an allowlisted env: no secrets even when set in process.env', async () => {
    const saved = {
      DATABASE_URL: process.env.DATABASE_URL,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      JWT_SECRET: process.env.JWT_SECRET,
      HTTP_PROXY: process.env.HTTP_PROXY,
    };
    process.env.DATABASE_URL = 'postgres://u:p@db/app';
    process.env.ENCRYPTION_KEY = 'enc-key';
    process.env.JWT_SECRET = 'jwt-secret';
    process.env.HTTP_PROXY = 'http://proxy:3128';
    try {
      const { buildHermesEnv } = await import('../src/lib/hermes-runner.js');
      const env = buildHermesEnv('/tmp/hermes-home');
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.JWT_SECRET).toBeUndefined();
      expect(env.HERMES_HOME).toBe('/tmp/hermes-home');
      expect(env.HERMES_YOLO_MODE).toBe('1');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.HTTP_PROXY).toBe('http://proxy:3128');
      expect(Object.keys(env).sort()).toEqual(
        ['HERMES_HOME', 'HERMES_YOLO_MODE', 'HOME', 'HTTP_PROXY', 'LANG', 'LC_ALL', 'PATH', 'TERM'].filter(
          (key) => key.startsWith('HERMES') || process.env[key] !== undefined,
        ),
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('omits proxy vars when they are not set', async () => {
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
    try {
      const { buildHermesEnv } = await import('../src/lib/hermes-runner.js');
      const env = buildHermesEnv('/tmp/hermes-home');
      expect(env.HTTP_PROXY).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.NO_PROXY).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it('spawned hermes child receives the scrubbed env, not process.env', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://u:p@db/app';
    try {
      const promise = runHermesTask(makeOpts());
      await closeWith(child, 0);
      await promise;
      const env = mocks.spawn.mock.calls[0]?.[2].env as Record<string, string>;
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.HERMES_YOLO_MODE).toBe('1');
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});

describe('runHermesTask cancellation', () => {
  it('kills the process and rejects when the task is cancelled mid-run', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    mocks.taskFindUnique.mockResolvedValue({ status: 'failed' });
    const promise = runHermesTask(makeOpts({ pollMs: 20 }));
    const err = await promise.then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe('cancelled by user');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps running when the cancel check itself throws synchronously', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    // A cleared/broken mock returns undefined, making findUnique().catch throw
    // synchronously inside the poll tick; the runner must swallow that.
    mocks.taskFindUnique.mockReturnValue(undefined);
    const promise = runHermesTask(makeOpts({ pollMs: 20 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await closeWith(child, 0);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('hermesConfigYaml', () => {
  // A YAML double-quoted scalar is exactly a JSON string, so a value that
  // JSON.parses back to the original is provably a valid quoted scalar that
  // round-trips. Anything not wrapped in quotes (or wrapping an unescaped
  // value) fails here — the bug this guards against.
  function quotedValue(yaml: string, key: string): string {
    const line = yaml.split('\n').find((l) => l.trimStart().startsWith(`${key}:`));
    if (!line) throw new Error(`no field '${key}' in:\n${yaml}`);
    const raw = line.slice(line.indexOf(':') + 1).trim();
    if (!raw.startsWith('"') || !raw.endsWith('"')) {
      throw new Error(`field '${key}' is not a double-quoted scalar: '${raw}'`);
    }
    return JSON.parse(raw);
  }

  const baseLlm: HermesLlmConfig = {
    baseUrl: 'https://llm.example/v1',
    apiKey: 'sk-test',
    model: 'model-x',
    contextWindow: 128_000,
  };

  it('double-quotes model, base_url, and api_key on the happy path', () => {
    const yaml = hermesConfigYaml(baseLlm);
    expect(quotedValue(yaml, 'default')).toBe('model-x');
    expect(quotedValue(yaml, 'base_url')).toBe('https://llm.example/v1');
    expect(quotedValue(yaml, 'api_key')).toBe('sk-test');
  });

  it('round-trips an api key containing a YAML comment marker', () => {
    const yaml = hermesConfigYaml({ ...baseLlm, apiKey: 'abc #123' });
    expect(quotedValue(yaml, 'api_key')).toBe('abc #123');
  });

  it('round-trips a base url containing a fragment', () => {
    const yaml = hermesConfigYaml({ ...baseLlm, baseUrl: 'https://gw.example/v1#frag' });
    expect(quotedValue(yaml, 'base_url')).toBe('https://gw.example/v1#frag');
  });

  it('round-trips a model name containing ": " and a reserved indicator', () => {
    const yaml = hermesConfigYaml({ ...baseLlm, model: 'weird: model*' });
    expect(quotedValue(yaml, 'default')).toBe('weird: model*');
  });

  it('round-trips values containing double quotes and backslashes', () => {
    const yaml = hermesConfigYaml({ ...baseLlm, apiKey: 'a"b\\c', model: 'm"' });
    expect(quotedValue(yaml, 'api_key')).toBe('a"b\\c');
    expect(quotedValue(yaml, 'default')).toBe('m"');
  });

  it('leaves provider, api_mode, and context_length as unquoted literals', () => {
    const yaml = hermesConfigYaml(baseLlm);
    expect(yaml).toContain('  provider: custom');
    expect(yaml).toContain('  api_mode: chat_completions');
    expect(yaml).toContain('  context_length: 128000');
  });
});
