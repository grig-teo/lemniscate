import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the pre-flight "is this already done?" check
// (lib/preflight-check.ts): verdict parsing, prompt shape, and the close
// decision. The LLM call + log/status side effects are mocked.
const mocks = vi.hoisted(() => ({
  llmCall: vi.fn(),
  logEvent: vi.fn(async () => undefined),
  setTaskStatus: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/agent-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agent-runtime.js')>()),
  llmCall: (...a: unknown[]) => mocks.llmCall(...a),
}));
vi.mock('../src/lib/task-events.js', () => ({ setTaskStatus: mocks.setTaskStatus }));

import {
  buildPreflightPrompt,
  closeIfAlreadyDone,
  parsePreflightVerdict,
  preflightAlreadyDone,
} from '../src/lib/preflight-check.js';
import type { TaskWithRepo } from '../src/lib/agent-runtime.js';

function fakeTask(digest: string | null): TaskWithRepo {
  return {
    id: 't1',
    title: 'Fix the pane stacking',
    prompt: 'Panes must replace each other',
    repository: { contextDigest: digest, defaultBranch: 'main' },
  } as unknown as TaskWithRepo;
}

const fakeRt = { cfg: { contextWindow: 32_000 } } as never;

beforeEach(() => vi.clearAllMocks());

describe('parsePreflightVerdict', () => {
  it('parses each verdict from the first line and keeps the evidence', () => {
    expect(parsePreflightVerdict('ALREADY_DONE\nselection.tsx clears panes in clearOtherPanes')).toEqual({
      verdict: 'already_done',
      evidence: 'selection.tsx clears panes in clearOtherPanes',
    });
    expect(parsePreflightVerdict('PARTIALLY_DONE\nonly the PR list is handled').verdict).toBe('partially_done');
    expect(parsePreflightVerdict('IMPLEMENT\nnothing similar exists').verdict).toBe('implement');
  });

  it('defaults to implement on garbage (never blocks work by accident)', () => {
    expect(parsePreflightVerdict('').verdict).toBe('implement');
    expect(parsePreflightVerdict('I think maybe it is done?').verdict).toBe('implement');
  });
});

describe('buildPreflightPrompt', () => {
  it('includes the digest, title, description and the unsure→IMPLEMENT rule', () => {
    const prompt = buildPreflightPrompt('Fix X', 'do X', 'ARCH DIGEST');
    expect(prompt).toContain('ARCH DIGEST');
    expect(prompt).toContain('Fix X');
    expect(prompt).toContain('do X');
    expect(prompt).toContain('When unsure, answer IMPLEMENT');
  });
});

describe('preflightAlreadyDone', () => {
  it('returns null without a digest (no verdict without evidence)', async () => {
    expect(await preflightAlreadyDone(fakeTask(null), fakeRt)).toBeNull();
    expect(mocks.llmCall).not.toHaveBeenCalled();
  });

  it('returns the parsed verdict and logs it', async () => {
    mocks.llmCall.mockResolvedValue('ALREADY_DONE\npresent in selection.tsx');
    const result = await preflightAlreadyDone(fakeTask('digest'), fakeRt);
    expect(result?.verdict).toBe('already_done');
    expect(mocks.logEvent).toHaveBeenCalledWith('t1', expect.stringContaining('already_done'));
  });

  it('returns null when the LLM call fails (proceed with implementation)', async () => {
    mocks.llmCall.mockRejectedValue(new Error('provider down'));
    expect(await preflightAlreadyDone(fakeTask('digest'), fakeRt)).toBeNull();
  });
});

describe('closeIfAlreadyDone', () => {
  it('flips the task to done only on an already_done verdict', async () => {
    mocks.llmCall.mockResolvedValue('ALREADY_DONE\nalready there');
    expect(await closeIfAlreadyDone(fakeTask('digest'), fakeRt)).toBe(true);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('t1', 'done');
  });

  it('does nothing on implement/partially_done', async () => {
    mocks.llmCall.mockResolvedValue('PARTIALLY_DONE\nhalf there');
    expect(await closeIfAlreadyDone(fakeTask('digest'), fakeRt)).toBe(false);
    expect(mocks.setTaskStatus).not.toHaveBeenCalled();
  });
});
