import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ChatToolCall } from '../src/lib/llm-client.js';
import type { LlmRuntime } from '../src/lib/agent-runtime.js';

// Mock the subagent tool wrapper so we can assert it was reached (the bug:
// runToolCalls never passed the runtime context to executeTool, so
// spawn_subagent always hit the "no runtime context" early return).
const spawnSubagentMock = vi.fn();
vi.mock('../src/lib/lemcore/subagent.js', () => ({
  spawnSubagentTool: (...args: unknown[]) => spawnSubagentMock(...args),
}));

// Mock multi-sample so we can assert verifyEditWithFallback is reached on the
// edit path when runtime context is present (the bug: it was never called).
const verifyEditMock = vi.fn();
vi.mock('../src/lib/lemcore/multi-sample.js', () => ({
  verifyEditWithFallback: (...args: unknown[]) => verifyEditMock(...args),
}));

import { runToolCalls } from '../src/lib/lemcore/loop-tool-runner.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-runner-'));
  spawnSubagentMock.mockReset();
  verifyEditMock.mockReset();
});

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(workdir, { recursive: true, force: true }));
  vi.clearAllMocks();
});

function tc(name: string, args: Record<string, unknown>): ChatToolCall {
  return {
    id: `call_${name}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function fakeRt(): LlmRuntime {
  return {
    cfg: { contextWindow: 32_000, baseUrl: 'http://x', model: 'm', apiPattern: 'openai' },
    apiKey: 'k',
    usedTokens: 0,
    usedPromptTokens: 0,
    usedCompletionTokens: 0,
    lastCallStartedAt: 0,
    triedConfigIds: [],
  } as unknown as LlmRuntime;
}

const noopPublish = async () => {};
const nextStepId = (() => { let n = 0; return () => `s${++n}`; })();

describe('runToolCalls → executeTool runtime-context plumbing', () => {
  it('reaches spawn_subagent when rt is provided (the broken seam)', async () => {
    spawnSubagentMock.mockResolvedValue({
      tool: 'spawn_subagent', title: 'spawn_subagent',
      outputPreview: 'investigation summary', durationMs: 3,
    });
    const messages: import('../src/lib/lemcore/loop-types.js').LemcoreMessage[] = [];

    await runToolCalls({
      taskId: 't1',
      workdir,
      secrets: [],
      toolCalls: [tc('spawn_subagent', { prompt: 'find callers of foo' })],
      messages,
      consecutiveToolFailures: 0,
      nextStepId,
      publishStepEvent: noopPublish,
      rt: fakeRt(),
    });

    expect(spawnSubagentMock).toHaveBeenCalledTimes(1);
    const ctxArg = spawnSubagentMock.mock.calls[0]![0] as { taskId: string } | undefined;
    expect(ctxArg?.taskId).toBe('t1');
    // The tool result surfaced to the model is the subagent summary.
    expect(messages.some((m) => m.role === 'tool' && m.content.includes('investigation summary'))).toBe(true);
  });

  it('still works without rt for plain tools (read_file)', async () => {
    await writeFile(path.join(workdir, 'hello.txt'), 'hi there');
    const messages: import('../src/lib/lemcore/loop-types.js').LemcoreMessage[] = [];

    await runToolCalls({
      taskId: 't2',
      workdir,
      secrets: [],
      toolCalls: [tc('read_file', { path: 'hello.txt' })],
      messages,
      consecutiveToolFailures: 0,
      nextStepId,
      publishStepEvent: noopPublish,
    });

    expect(messages.some((m) => m.role === 'tool' && m.content.includes('hi there'))).toBe(true);
  });

  it('returns a soft error for spawn_subagent when rt is absent', async () => {
    spawnSubagentMock.mockResolvedValue({
      tool: 'spawn_subagent', title: 'spawn_subagent', durationMs: 0,
      outputPreview: 'Subagent unavailable (no runtime context).',
      error: 'spawn_subagent requires runtime context',
    });
    const messages: import('../src/lib/lemcore/loop-types.js').LemcoreMessage[] = [];

    const failures = await runToolCalls({
      taskId: 't3',
      workdir,
      secrets: [],
      toolCalls: [tc('spawn_subagent', { prompt: 'x' })],
      messages,
      consecutiveToolFailures: 0,
      nextStepId,
      publishStepEvent: noopPublish,
      // no rt
    });

    // spawn_subagent is a soft failure: must NOT count as a tool failure.
    expect(failures).toBe(0);
    // ctx is undefined when rt is absent.
    expect(spawnSubagentMock.mock.calls[0]![0]).toBeUndefined();
    expect(messages.some((m) => m.role === 'tool' && /no runtime context/i.test(m.content))).toBe(true);
  });
});

describe('runToolCalls → unlimited tool failures', () => {
  it('never aborts, no matter how many consecutive failures occur', async () => {
    const messages: import('../src/lib/lemcore/loop-types.js').LemcoreMessage[] = [];

    // 5 consecutive failing reads — well past the old MAX_TOOL_FAILURES=2
    // abort threshold. The run must NOT throw; the model keeps seeing the
    // errors and can reroute.
    const failures = await runToolCalls({
      taskId: 't6',
      workdir,
      secrets: [],
      toolCalls: Array.from({ length: 5 }, (_, i) =>
        tc('read_file', { path: `missing-${i}.txt` }),
      ),
      messages,
      consecutiveToolFailures: 0,
      nextStepId,
      publishStepEvent: noopPublish,
    });

    expect(failures).toBe(5);
    expect(messages.filter((m) => m.role === 'tool' && m.content.startsWith('Error:'))).toHaveLength(5);
  });
});

describe('runToolCalls → loop detection', () => {
  it('nudges at 3 and blocks at 5 identical read-only calls', async () => {
    await writeFile(path.join(workdir, 'a.txt'), 'x');
    const messages: import('../src/lib/lemcore/loop-types.js').LemcoreMessage[] = [];

    await runToolCalls({
      taskId: 't7',
      workdir,
      secrets: [],
      toolCalls: Array.from({ length: 5 }, () => tc('read_file', { path: 'a.txt' })),
      messages,
      consecutiveToolFailures: 0,
      nextStepId,
      publishStepEvent: noopPublish,
    });

    const contents = messages.filter((m) => m.role === 'tool').map((m) => m.content);
    // 3rd identical call carries the nudge; the 5th is blocked with an error.
    expect(contents[2]).toContain('loop-detection');
    expect(contents[4]).toContain('blocked');
    expect(contents[4]).toContain('Error:');
  });
});

describe('runToolCalls → multi-sample edit verification wiring', () => {
  it('routes edit_file through verifyEditWithFallback when rt is present', async () => {
    verifyEditMock.mockResolvedValue({
      tool: 'edit_file', title: 'a.ts',
      outputPreview: 'edited a.ts (lint clean)', durationMs: 5,
    });
    await writeFile(path.join(workdir, 'a.ts'), 'export const x = 1;\n');
    const messages: import('../src/lib/lemcore/loop-types.js').LemcoreMessage[] = [];

    await runToolCalls({
      taskId: 't4',
      workdir,
      secrets: [],
      toolCalls: [tc('edit_file', { path: 'a.ts', search: 'x = 1', replace: 'x = 2' })],
      messages,
      consecutiveToolFailures: 0,
      nextStepId,
      publishStepEvent: noopPublish,
      rt: fakeRt(),
    });

    expect(verifyEditMock).toHaveBeenCalledTimes(1);
    const passed = verifyEditMock.mock.calls[0]![0] as { rt: LlmRuntime; taskId: string };
    expect(passed.taskId).toBe('t4');
    expect(passed.rt).toBeDefined();
    expect(messages.some((m) => m.role === 'tool' && m.content.includes('lint clean'))).toBe(true);
  });

  it('does NOT route edit_file through multi-sample when rt is absent', async () => {
    await writeFile(path.join(workdir, 'b.ts'), 'export const y = 1;\n');
    const messages: import('../src/lib/lemcore/loop-types.js').LemcoreMessage[] = [];

    await runToolCalls({
      taskId: 't5',
      workdir,
      secrets: [],
      toolCalls: [tc('edit_file', { path: 'b.ts', search: 'y = 1', replace: 'y = 2' })],
      messages,
      consecutiveToolFailures: 0,
      nextStepId,
      publishStepEvent: noopPublish,
      // no rt — must fall back to the plain lint-gated edit
    });

    expect(verifyEditMock).not.toHaveBeenCalled();
    // Plain edit still applies (lintAndMaybeRevert with no lint config → accepted).
    expect(messages.some((m) => m.role === 'tool' && /edited b\.ts/.test(m.content))).toBe(true);
  });
});
