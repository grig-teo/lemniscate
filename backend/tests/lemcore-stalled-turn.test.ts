import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Locks the lemcore stall watchdog: a single LLM turn that never replies
// (hung provider, dead stream) must abort the run with LemcoreStalledError
// instead of pinning the worker slot until the wall-clock cap fires.

const mocks = vi.hoisted(() => ({
  chatCompletion: vi.fn(),
  publishTaskEvent: vi.fn(),
}));

vi.mock('../src/lib/llm-dispatch.js', () => ({ chatCompletion: mocks.chatCompletion }));
vi.mock('../src/lib/task-events.js', () => ({ publishTaskEvent: mocks.publishTaskEvent }));

import { runLemcoreLoop, LemcoreStalledError } from '../src/lib/lemcore/loop.js';
import type { LemcoreRunOptions } from '../src/lib/lemcore/loop-types.js';

let workdir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.publishTaskEvent.mockResolvedValue(undefined);
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-stalled-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function makeOpts(overrides: Partial<LemcoreRunOptions> = {}): LemcoreRunOptions {
  return {
    taskId: 'task-stall',
    task: { id: 'task-stall', title: 't', prompt: 'p' } as LemcoreRunOptions['task'],
    workdir,
    rt: {
      cfg: { baseUrl: 'https://llm.example/v1', model: 'm', contextWindow: 128_000 },
      apiKey: 'sk-test',
      usedTokens: 0,
      usedPromptTokens: 0,
      usedCompletionTokens: 0,
    } as LemcoreRunOptions['rt'],
    prompt: 'do the thing',
    secrets: [],
    ...overrides,
  };
}

describe('runLemcoreLoop stalled turn', () => {
  it('throws LemcoreStalledError when one chat turn never settles', async () => {
    // A provider that accepts the request and then hangs forever.
    mocks.chatCompletion.mockReturnValue(new Promise(() => {}));
    const promise = runLemcoreLoop(makeOpts({ turnTimeoutMs: 30 }));
    const err = await promise.then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(LemcoreStalledError);
    expect(err?.name).toBe('LemcoreStalledError');
    expect(err?.message).toContain('lemcore run stalled');
    expect(err?.message).toContain('turn 1');
  });

  it('completes the turn when the provider replies inside the window', async () => {
    mocks.chatCompletion.mockResolvedValue({
      content: 'done',
      hasToolCalls: false,
      toolCalls: [],
    });
    const result = await runLemcoreLoop(makeOpts({ turnTimeoutMs: 5_000 }));
    expect(result).toBe('done');
  });
});
