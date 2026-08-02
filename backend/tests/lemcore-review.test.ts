import path from 'node:path';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Locks runLemcoreReview against the silent-stop bug: when lemcore's
// agent loop finishes without writing .lemniscate-review.json, the task
// is stuck in reviewing_code. The fix mirrors executeHermesReview's
// fallback to a direct LLM review.

const mocks = vi.hoisted(() => ({
  checkoutTaskBranch: vi.fn(),
  logEvent: vi.fn(),
  commitAndPush: vi.fn(),
  hasDirtyWorkdir: vi.fn(),
  runLemcoreLoop: vi.fn(),
  loadTranscript: vi.fn(() => null),
  continueOrFinishReview: vi.fn(),
  fetchReviewDiff: vi.fn(),
  requestReviewDirect: vi.fn(),
  llmCall: vi.fn(),
}));

vi.mock('../src/lib/agent-git.js', () => ({
  checkoutTaskBranch: mocks.checkoutTaskBranch,
  logEvent: mocks.logEvent,
  commitAndPush: mocks.commitAndPush,
  hasDirtyWorkdir: mocks.hasDirtyWorkdir,
}));
vi.mock('../src/lib/lemcore/loop.js', () => ({
  runLemcoreLoop: mocks.runLemcoreLoop,
  loadTranscript: (...a: unknown[]) => mocks.loadTranscript(...a),
}));
vi.mock('../src/lib/review-finish.js', () => ({ continueOrFinishReview: mocks.continueOrFinishReview }));
vi.mock('../src/lib/agent-review.js', () => ({
  fetchReviewDiff: mocks.fetchReviewDiff,
  requestReview: mocks.requestReviewDirect,
}));
vi.mock('../src/lib/agent-runtime.js', () => ({ llmCall: mocks.llmCall }));

import { runLemcoreReview } from '../src/lib/lemcore/review.js';

const reviewVerdictApproved = JSON.stringify({
  verdict: 'approve',
  summary: 'Looks fine.',
  issues: [],
});

function task(): never {
  return {
    id: 't-lemcore-no-review',
    title: 't',
    prompt: 'p',
    repository: { defaultBranch: 'main', systemPromptExtra: null },
  } as never;
}
function rt(): never {
  return { cfg: { model: 'm', baseUrl: 'b', apiKey: 'k', temperature: 0, maxTokens: 4096 }, usedTokens: 1 } as never;
}

let workdir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-review-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('runLemcoreReview — no verdict file', () => {
  it('falls back to a direct LLM review when lemcore leaves no verdict file', async () => {
    mocks.runLemcoreLoop.mockResolvedValue('');
    mocks.fetchReviewDiff.mockResolvedValue('diff content');
    const verdict = { verdict: 'approved' as const, summary: 'fine', issues: [] };
    mocks.requestReviewDirect.mockResolvedValue(verdict);

    await runLemcoreReview(
      task(),
      rt(),
      'lemniscate/branch',
      0,
      workdir,
      'https://clone',
      [],
      { username: 'u', token: 't' },
    );

    expect(mocks.fetchReviewDiff).toHaveBeenCalledTimes(1);
    expect(mocks.requestReviewDirect).toHaveBeenCalledTimes(1);
    expect(mocks.continueOrFinishReview).toHaveBeenCalledTimes(1);
  });

  it('still resumes normally a verdict file exists', async () => {
    mocks.runLemcoreLoop.mockImplementation(async (opts: { workdir: string }) => {
      await writeFile(path.join(opts.workdir, '.lemniscate-review.json'), reviewVerdictApproved);
      return '';
    });
    const verdict = { verdict: 'approved' as const, summary: 'fine', issues: [] };
    mocks.continueOrFinishReview.mockImplementation(async () => verdict);

    await runLemcoreReview(
      task(),
      rt(),
      'lemniscate/branch',
      0,
      workdir,
      'https://clone',
      [],
      { username: 'u', token: 't' },
    );

    expect(mocks.fetchReviewDiff).not.toHaveBeenCalled();
    expect(mocks.requestReviewDirect).not.toHaveBeenCalled();
    expect(mocks.continueOrFinishReview).toHaveBeenCalledTimes(1);
    expect((await readdir(workdir)).length).toBe(0);
  });
});

describe('runLemcoreReview — transcript resume', () => {
  it('continues a re-enqueued review from the saved transcript instead of restarting', async () => {
    const transcript = [{ role: 'user' as const, content: 'earlier review progress' }];
    mocks.loadTranscript.mockReturnValueOnce(transcript);
    mocks.runLemcoreLoop.mockResolvedValue('');

    await runLemcoreReview(
      task(),
      rt(),
      'lemniscate/branch',
      0,
      workdir,
      'https://clone',
      [],
      { username: 'u', token: 't' },
    );

    const opts = mocks.runLemcoreLoop.mock.calls[0]![0] as { resumeTranscript?: unknown };
    expect(opts.resumeTranscript).toEqual(transcript);
  });

  it('passes no resumeTranscript when no transcript exists (fresh review)', async () => {
    mocks.runLemcoreLoop.mockResolvedValue('');

    await runLemcoreReview(
      task(),
      rt(),
      'lemniscate/branch',
      0,
      workdir,
      'https://clone',
      [],
      { username: 'u', token: 't' },
    );

    const opts = mocks.runLemcoreLoop.mock.calls[0]![0] as { resumeTranscript?: unknown };
    expect(opts.resumeTranscript).toBeUndefined();
  });
});