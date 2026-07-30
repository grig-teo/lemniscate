import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locks the review retry-with-nudge: empty/invalid LLM replies (a z.ai GLM
// quirk) are retried up to 3 times with an explicit nudge appended to the
// conversation; real endpoint errors rethrow on the first attempt.

const mocks = vi.hoisted(() => ({
  llmCall: vi.fn(),
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/agent-runtime.js', () => ({ llmCall: mocks.llmCall }));
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));

import { requestReviewWithRetry } from '../src/lib/review-request.js';

const rt = { cfg: { systemPromptExtra: null } } as never;
const task = { id: 't1', title: 'Add feature', prompt: 'do it' } as never;
const VALID_REVIEW = '{"verdict":"approve","summary":"looks good","issues":[]}';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logEvent.mockResolvedValue(undefined);
});

describe('requestReviewWithRetry', () => {
  it('returns the parsed review on a clean first reply', async () => {
    mocks.llmCall.mockResolvedValue(VALID_REVIEW);

    const review = await requestReviewWithRetry(rt, task, 'diff');

    expect(review.verdict).toBe('approve');
    expect(mocks.llmCall).toHaveBeenCalledTimes(1);
  });

  it('nudges and retries after empty replies, then succeeds', async () => {
    mocks.llmCall
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('   ')
      .mockResolvedValueOnce(VALID_REVIEW);

    const review = await requestReviewWithRetry(rt, task, 'diff');

    expect(review.verdict).toBe('approve');
    expect(mocks.llmCall).toHaveBeenCalledTimes(3);
    // The nudge is appended as a user message after each empty reply.
    const secondMessages = mocks.llmCall.mock.calls[1][1] as { role: string; content: string }[];
    expect(secondMessages.at(-1)).toMatchObject({ role: 'user' });
    expect(secondMessages.at(-1)?.content).toContain('ONLY the JSON review object');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      't1',
      'empty/invalid review reply — asking the model again (1/3)',
    );
  });

  it('throws after 3 invalid replies instead of looping forever', async () => {
    mocks.llmCall.mockResolvedValue('not json at all');

    await expect(requestReviewWithRetry(rt, task, 'diff')).rejects.toThrow(/JSON/);
    expect(mocks.llmCall).toHaveBeenCalledTimes(3);
  });

  it('rethrows endpoint errors immediately without retrying', async () => {
    mocks.llmCall.mockRejectedValue(new Error('LLM endpoint returned HTTP 401: unauthorized'));

    await expect(requestReviewWithRetry(rt, task, 'diff')).rejects.toThrow('HTTP 401');
    expect(mocks.llmCall).toHaveBeenCalledTimes(1);
  });

  it('retries schema-mismatch replies (the zod invalid-review error)', async () => {
    mocks.llmCall
      .mockResolvedValueOnce('{"verdict":"approve","summary":"","issues":[]}')
      .mockResolvedValueOnce(VALID_REVIEW);

    const review = await requestReviewWithRetry(rt, task, 'diff');

    expect(review.summary).toBe('looks good');
    expect(mocks.llmCall).toHaveBeenCalledTimes(2);
  });
});
