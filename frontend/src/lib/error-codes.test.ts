import { describe, expect, it } from 'vitest';

import { getErrorBannerInfo, hasActionableError } from '@/lib/error-codes';

// Tests for the frontend error-code → banner message-id mapping. Every
// backend TaskErrorCode must map to `error.<CODE>.title` / `error.<CODE>.hint`
// message ids (the copy lives in the locale catalogs). The settings tab
// target is verified so the banner can deep-link the user to the fix.

describe('getErrorBannerInfo', () => {
  it.each([
    'LLM_AUTH_FAILED',
    'LLM_RATE_LIMITED',
    'LLM_QUOTA_EXCEEDED',
    'LLM_TIMEOUT',
    'LLM_CONNECTION_FAILED',
    'LLM_SERVER_ERROR',
    'GIT_AUTH_FAILED',
    'GIT_PERMISSION_DENIED',
    'GIT_WORKFLOW_SCOPE',
    'PROPOSAL_GENERATION_FAILED',
  ])('returns title/hint message ids for %s', (code) => {
    const info = getErrorBannerInfo(code);
    expect(info.code).toBe(code);
    expect(info.titleId).toBe(`error.${code}.title`);
    expect(info.hintId).toBe(`error.${code}.hint`);
  });

  it('points LLM codes at the llm settings tab', () => {
    expect(getErrorBannerInfo('LLM_AUTH_FAILED').settingsTab).toBe('llm');
    expect(getErrorBannerInfo('LLM_QUOTA_EXCEEDED').settingsTab).toBe('llm');
    expect(getErrorBannerInfo('PROPOSAL_GENERATION_FAILED').settingsTab).toBe('llm');
  });

  it('points git codes at the git settings tab', () => {
    expect(getErrorBannerInfo('GIT_AUTH_FAILED').settingsTab).toBe('git');
    expect(getErrorBannerInfo('GIT_PERMISSION_DENIED').settingsTab).toBe('git');
    expect(getErrorBannerInfo('GIT_WORKFLOW_SCOPE').settingsTab).toBe('git');
  });

  it('returns the UNKNOWN fallback ids for UNKNOWN', () => {
    const info = getErrorBannerInfo('UNKNOWN');
    expect(info.code).toBe('UNKNOWN');
    expect(info.titleId).toBe('error.UNKNOWN.title');
    expect(info.hintId).toBe('error.UNKNOWN.hint');
  });

  it('returns the UNKNOWN fallback for an unrecognized code', () => {
    const info = getErrorBannerInfo('SOME_NEW_CODE');
    expect(info.code).toBe('UNKNOWN');
    expect(info.titleId).toBe('error.UNKNOWN.title');
    expect(info.hintId).toBe('error.UNKNOWN.hint');
  });

  it('returns the UNKNOWN fallback for null', () => {
    expect(getErrorBannerInfo(null).code).toBe('UNKNOWN');
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
