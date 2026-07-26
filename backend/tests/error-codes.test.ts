import { describe, expect, it } from 'vitest';

import { LlmError } from '../src/lib/llm-client.js';
import { classifyError, TaskErrorCode } from '../src/lib/errors.js';

// Unit tests for the backend error classification layer (errors.ts). Every
// test pins one raw exception shape to the structured TaskErrorCode the agent
// loop persists on failure. The frontend maps these codes to user-friendly
// banners, so a wrong mapping means a wrong or missing hint.

describe('classifyError', () => {
  describe('LLM errors (LlmError instances)', () => {
    it('classifies HTTP 401 as LLM_AUTH_FAILED', () => {
      const err = new LlmError('http', 'LLM endpoint returned HTTP 401: Unauthorized', 401);
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_AUTH_FAILED);
    });

    it('classifies HTTP 403 as LLM_AUTH_FAILED', () => {
      const err = new LlmError('http', 'LLM endpoint returned HTTP 403', 403);
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_AUTH_FAILED);
    });

    it('classifies HTTP 429 as LLM_RATE_LIMITED', () => {
      const err = new LlmError('http', 'LLM endpoint returned HTTP 429: Too Many Requests', 429);
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_RATE_LIMITED);
    });

    it('classifies HTTP 402 as LLM_QUOTA_EXCEEDED', () => {
      const err = new LlmError('http', 'LLM endpoint returned HTTP 402: Payment Required', 402);
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_QUOTA_EXCEEDED);
    });

    it('classifies quota message as LLM_QUOTA_EXCEEDED', () => {
      const err = new LlmError('http', 'insufficient_quota', 429);
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_QUOTA_EXCEEDED);
    });

    it('classifies HTTP 500 as LLM_SERVER_ERROR', () => {
      const err = new LlmError('http', 'LLM endpoint returned HTTP 500', 500);
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_SERVER_ERROR);
    });

    it('classifies HTTP 503 as LLM_SERVER_ERROR', () => {
      const err = new LlmError('http', 'LLM endpoint returned HTTP 503', 503);
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_SERVER_ERROR);
    });

    it('classifies timeout kind as LLM_TIMEOUT', () => {
      const err = new LlmError('timeout', 'Request timed out after 120s');
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_TIMEOUT);
    });

    it('classifies network kind as LLM_CONNECTION_FAILED', () => {
      const err = new LlmError('network', 'Network error calling LLM endpoint: connect ECONNREFUSED');
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_CONNECTION_FAILED);
    });

    it('classifies protocol kind as UNKNOWN', () => {
      const err = new LlmError('protocol', 'LLM endpoint returned invalid JSON');
      expect(classifyError(err)).toBe(TaskErrorCode.UNKNOWN);
    });
  });

  describe('LLM errors (plain Error with message signatures)', () => {
    it('classifies "Incorrect API key" message as LLM_AUTH_FAILED', () => {
      const err = new Error('Incorrect API key provided: sk-test...');
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_AUTH_FAILED);
    });

    it('classifies "invalid api key" message as LLM_AUTH_FAILED', () => {
      const err = new Error('The API key is invalid or has been revoked');
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_AUTH_FAILED);
    });

    it('classifies timeout message as LLM_TIMEOUT', () => {
      const err = new Error('Request timed out after 120s (attempt 4 of 4)');
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_TIMEOUT);
    });

    it('classifies connection refused as LLM_CONNECTION_FAILED', () => {
      const err = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:8080');
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_CONNECTION_FAILED);
    });

    it('classifies DNS failure as LLM_CONNECTION_FAILED', () => {
      const err = new Error('getaddrinfo ENOTFOUND api.openai.com');
      expect(classifyError(err)).toBe(TaskErrorCode.LLM_CONNECTION_FAILED);
    });
  });

  describe('git errors (message signatures)', () => {
    it('classifies git authentication failure as GIT_AUTH_FAILED', () => {
      const err = new Error("fatal: Authentication failed for 'https://github.com/repo.git'");
      expect(classifyError(err)).toBe(TaskErrorCode.GIT_AUTH_FAILED);
    });

    it('classifies git "could not read Username" as GIT_AUTH_FAILED', () => {
      const err = new Error("fatal: could not read Username for 'https://github.com/repo.git'");
      expect(classifyError(err)).toBe(TaskErrorCode.GIT_AUTH_FAILED);
    });

    it('classifies git permission denied (403) as GIT_PERMISSION_DENIED', () => {
      const err = new Error('remote: Permission to org/repo.git denied to user');
      expect(classifyError(err)).toBe(TaskErrorCode.GIT_PERMISSION_DENIED);
    });

    it('classifies git push 403 as GIT_PERMISSION_DENIED', () => {
      const err = new Error('fatal: unable to access: 403 Forbidden');
      expect(classifyError(err)).toBe(TaskErrorCode.GIT_PERMISSION_DENIED);
    });

    it('classifies git workflow scope rejection as GIT_WORKFLOW_SCOPE', () => {
      const err = new Error(
        'remote: error: GH006: refusing to allow an OAuth App to create or update workflow',
      );
      expect(classifyError(err)).toBe(TaskErrorCode.GIT_WORKFLOW_SCOPE);
    });

    it('classifies git workflow scope (without scope) as GIT_WORKFLOW_SCOPE', () => {
      const err = new Error('remote: error: GH006: without `workflow` scope');
      expect(classifyError(err)).toBe(TaskErrorCode.GIT_WORKFLOW_SCOPE);
    });
  });

  describe('fallback', () => {
    it('returns UNKNOWN for unrecognized errors', () => {
      const err = new Error('Something unexpected happened');
      expect(classifyError(err)).toBe(TaskErrorCode.UNKNOWN);
    });

    it('returns UNKNOWN for non-Error values', () => {
      expect(classifyError('a plain string')).toBe(TaskErrorCode.UNKNOWN);
      expect(classifyError({ foo: 'bar' })).toBe(TaskErrorCode.UNKNOWN);
      expect(classifyError(null)).toBe(TaskErrorCode.UNKNOWN);
      expect(classifyError(undefined)).toBe(TaskErrorCode.UNKNOWN);
    });

    it('prioritizes git workflow scope over generic permission denied', () => {
      const err = new Error(
        'remote: Permission denied. refusing to allow an OAuth App to create or update workflow',
      );
      expect(classifyError(err)).toBe(TaskErrorCode.GIT_WORKFLOW_SCOPE);
    });
  });
});

// Backend→frontend contract: the frontend ERROR_BANNER_MAP
// (frontend/src/lib/error-codes.ts) is keyed by the literal string values of
// these enum members. If an enum value diverges from its key name (e.g. set to
// a placeholder), getErrorBannerInfo() falls through to the generic UNKNOWN
// fallback — silently disabling the actionable hint for that failure type.
// These assertions pin the wire contract so the same corruption cannot recur.
describe('TaskErrorCode enum values (backend→frontend contract)', () => {
  it.each([
    ['LLM_AUTH_FAILED', TaskErrorCode.LLM_AUTH_FAILED],
    ['LLM_RATE_LIMITED', TaskErrorCode.LLM_RATE_LIMITED],
    ['LLM_QUOTA_EXCEEDED', TaskErrorCode.LLM_QUOTA_EXCEEDED],
    ['LLM_TIMEOUT', TaskErrorCode.LLM_TIMEOUT],
    ['LLM_CONNECTION_FAILED', TaskErrorCode.LLM_CONNECTION_FAILED],
    ['LLM_SERVER_ERROR', TaskErrorCode.LLM_SERVER_ERROR],
    ['GIT_AUTH_FAILED', TaskErrorCode.GIT_AUTH_FAILED],
    ['GIT_PERMISSION_DENIED', TaskErrorCode.GIT_PERMISSION_DENIED],
    ['GIT_WORKFLOW_SCOPE', TaskErrorCode.GIT_WORKFLOW_SCOPE],
    ['UNKNOWN', TaskErrorCode.UNKNOWN],
  ])('%s equals its literal string', (_name, code) => {
    expect(code).toBe(_name);
  });
});
