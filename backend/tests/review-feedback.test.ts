import { describe, expect, it } from 'vitest';
import {
  isAgentAuthoredComment,
  isReviewCommentCovered,
  reviewFeedbackSkipReason,
} from '../src/lib/review-feedback.js';

// Unit tests for the pure review-feedback rules (single home shared by the
// webhook dispatch, the address-review job, and the pr-state-sync poll).

const COMMENT = { id: 'rc-100', body: 'please fix the null case', author: 'human-reviewer' };

function skip(overrides: Record<string, unknown> = {}) {
  return reviewFeedbackSkipReason({
    taskStatus: 'awaiting_review',
    branchName: 'lemniscate/t-1',
    lastAddressedReviewId: null,
    autoAddressReview: true,
    connectionUsername: 'agent-bot',
    comment: COMMENT,
    ...overrides,
  });
}

describe('isAgentAuthoredComment', () => {
  it('matches the connection username case-insensitively', () => {
    expect(isAgentAuthoredComment('Agent-Bot', 'agent-bot')).toBe(true);
    expect(isAgentAuthoredComment('human-reviewer', 'agent-bot')).toBe(false);
  });

  it('never matches when the connection has no username', () => {
    expect(isAgentAuthoredComment('agent-bot', null)).toBe(false);
    expect(isAgentAuthoredComment('agent-bot', undefined)).toBe(false);
  });
});

describe('isReviewCommentCovered', () => {
  it('covers the exact id and older numeric ids of the same namespace', () => {
    expect(isReviewCommentCovered('rc-100', 'rc-100')).toBe(true);
    expect(isReviewCommentCovered('rc-100', 'rc-99')).toBe(true);
    expect(isReviewCommentCovered('rc-100', 'rc-101')).toBe(false);
  });

  it('treats a missing marker as "nothing covered"', () => {
    expect(isReviewCommentCovered(null, 'rc-1')).toBe(false);
    expect(isReviewCommentCovered(undefined, 'rc-1')).toBe(false);
  });

  it('falls back to exact equality for non-numeric ids', () => {
    expect(isReviewCommentCovered('abc', 'abc')).toBe(true);
    expect(isReviewCommentCovered('abc', 'abd')).toBe(false);
  });
});

describe('reviewFeedbackSkipReason', () => {
  it('allows an actionable human comment', () => {
    expect(skip()).toBeNull();
  });

  it('skips when the repo flag is off (default: do not intervene)', () => {
    expect(skip({ autoAddressReview: false })).toBe('flag_off');
  });

  it('skips tasks that are not awaiting review', () => {
    expect(skip({ taskStatus: 'done' })).toBe('not_awaiting_review');
    expect(skip({ taskStatus: 'running' })).toBe('not_awaiting_review');
    expect(skip({ taskStatus: 'reviewing_code' })).toBeNull();
  });

  it('skips tasks without a branch', () => {
    expect(skip({ branchName: null })).toBe('no_branch');
  });

  it('skips comments authored by the agent itself', () => {
    expect(skip({ comment: { ...COMMENT, author: 'AGENT-BOT' } })).toBe('own_comment');
  });

  it('skips already-addressed comments (webhook redelivery / poll race)', () => {
    expect(skip({ lastAddressedReviewId: 'rc-100' })).toBe('duplicate');
    expect(skip({ lastAddressedReviewId: 'rc-150' })).toBe('duplicate');
    expect(skip({ lastAddressedReviewId: 'rc-99' })).toBeNull();
  });

  it('skips empty comments', () => {
    expect(skip({ comment: { ...COMMENT, body: '   ' } })).toBe('empty');
  });
});
