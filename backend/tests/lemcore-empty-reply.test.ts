import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Locks the empty-reply guard: providers like z.ai GLM intermittently return
// an assistant message with empty content and no tool calls (finish_reason
// "stop" after the reasoning budget is consumed). The loop must nudge the
// model and continue — not treat the empty reply as the final answer, which
// ended runs as 'done' after a few read_file turns with zero changes.

const mocks = vi.hoisted(() => ({
  chatCompletion: vi.fn(),
  publishTaskEvent: vi.fn(),
}));

vi.mock('../src/lib/llm-dispatch.js', () => ({ chatCompletion: mocks.chatCompletion }));
vi.mock('../src/lib/task-events.js', () => ({ publishTaskEvent: mocks.publishTaskEvent }));

import { runLemcoreLoop } from '../src/lib/lemcore/loop.js';
import type { LemcoreRunOptions } from '../src/lib/lemcore/loop-types.js';

let workdir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.chatCompletion.mockReset();
  mocks.publishTaskEvent.mockResolvedValue(undefined);
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-empty-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function makeOpts(overrides: Partial<LemcoreRunOptions> = {}): LemcoreRunOptions {
  return {
    taskId: 'task-empty',
    task: { id: 'task-empty', title: 't', prompt: 'p' } as LemcoreRunOptions['task'],
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

describe('runLemcoreLoop empty assistant replies', () => {
  it('nudges the model and continues after an empty reply', async () => {
    mocks.chatCompletion
      .mockResolvedValueOnce({ content: '', hasToolCalls: false, toolCalls: [] })
      .mockResolvedValueOnce({ content: 'implemented everything', hasToolCalls: false, toolCalls: [] });

    const result = await runLemcoreLoop(makeOpts());

    expect(result).toBe('implemented everything');
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
    const secondCallMessages = mocks.chatCompletion.mock.calls[1][0].messages as {
      role: string;
      content: string;
    }[];
    const nudge = secondCallMessages.find(
      (m) => m.role === 'user' && /empty/i.test(m.content),
    );
    expect(nudge).toBeDefined();
  });

  it('treats whitespace-only content as empty', async () => {
    mocks.chatCompletion
      .mockResolvedValueOnce({ content: '  \n ', hasToolCalls: false, toolCalls: [] })
      .mockResolvedValueOnce({ content: 'real summary', hasToolCalls: false, toolCalls: [] });

    const result = await runLemcoreLoop(makeOpts());

    expect(result).toBe('real summary');
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('throws after 3 consecutive empty replies instead of ending the run', async () => {
    mocks.chatCompletion.mockResolvedValue({
      content: '',
      hasToolCalls: false,
      toolCalls: [],
    });

    const err = await runLemcoreLoop(makeOpts()).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/empty/i);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(3);
  });

  it('returns immediately on a non-empty final answer without nudging', async () => {
    mocks.chatCompletion.mockResolvedValue({
      content: 'all done',
      hasToolCalls: false,
      toolCalls: [],
    });

    const result = await runLemcoreLoop(makeOpts());

    expect(result).toBe('all done');
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
  });
});
