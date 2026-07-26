import { describe, expect, it } from 'vitest';

import {
  getErrorBannerInfo,
  hasActionableError,
  type TaskErrorCode,
} from '@/lib/error-codes';

// Tests for the frontend error-code → user-friendly banner mapping. Every
// backend TaskErrorCode must map to a non-empty title + hint. The settings
// tab target is verified so the banner can deep-link the user to the fix.

describe('getErrorBannerInfo', () => {
  it('returns a title and hint for LLM_AUTH_FAILED', () => {
    const info = getErrorBannerInfo('LLM_AUTH_FAILED');
    expect(info.title).toBeTruthy();
    expect(info.hint).toBeTruthy();
    expect(info.settingsTab).toBe('llm');
  });

  it('returns a title and hint for LLM_RATE_LIMITED', () => {
    const info = getErrorBannerInfo('LLM_RATE_LIMITED');
    expect(info.title).toContain('rate');
    expect(info.hint).toBeTruthy();
  });

  it('returns a title and hint for LLM_QUOTA_EXCEEDED', () => {
    const info = getErrorBannerInfo('LLM_QUOTA_EXCEEDED');
    expect(info.title).toContain('quota');
    expect(info.settingsTab).toBe('llm');
  });

  it('returns a title and hint for LLM_TIMEOUT', () => {
    const info = getErrorBannerInfo('LLM_TIMEOUT');
    expect(info.title).toContain('timed out');
  });

  it('returns a title and hint for LLM_CONNECTION_FAILED', () => {
    const info = getErrorBannerInfo('LLM_CONNECTION_FAILED');
    expect(info.title).toContain('connect');
  });

  it('returns a title and hint for LLM_SERVER_ERROR', () => {
    const info = getErrorBannerInfo('LLM_SERVER_ERROR');
    expect(info.title).toContain('server');
  });

  it('returns a title and hint for GIT_AUTH_FAILED', () => {
    const info = getErrorBannerInfo('GIT_AUTH_FAILED');
    expect(info.title).toContain('authentication');
    expect(info.settingsTab).toBe('git');
  });

  it('returns a title and hint for GIT_PERMISSION_DENIED', () => {
    const info = getErrorBannerInfo('GIT_PERMISSION_DENIED');
    expect(info.title).toContain('permission');
    expect(info.settingsTab).toBe('git');
  });

  it('returns a title and hint for GIT_WORKFLOW_SCOPE', () => {
    const info = getErrorBannerInfo('GIT_WORKFLOW_SCOPE');
    expect(info.title).toContain('workflow');
    expect(info.hint).toContain('scope');
  });

  it('returns a generic fallback for UNKNOWN', () => {
    const info = getErrorBannerInfo('UNKNOWN');
    expect(info.title).toBeTruthy();
    expect(info.hint).toBeTruthy();
  });

  it('returns a generic fallback for an unrecognized code', () => {
    const info = getErrorBannerInfo('SOME_NEW_CODE');
    expect(info.title).toBeTruthy();
    expect(info.hint).toBeTruthy();
  });

  it('returns a generic fallback for null', () => {
    const info = getErrorBannerInfo(null);
    expect(info.title).toBeTruthy();
    expect(info.hint).toBeTruthy();
  });
});

describe('hasActionableError', () => {
  it('returns true for known actionable codes', () => {
    expect(hasActionableError('LLM_AUTH_FAILED')).toBe(true);
    expect(hasActionableError('GIT_PERMISSION_DENIED')).toBe(true);
  });

  it('returns false for UNKNOWN', () => {
    expect(hasActionableError('UNKNOWN')).toBe(false);
  });

  it('returns false for null', () => {
    expect(hasActionableError(null)).toBe(false);
  });
});
