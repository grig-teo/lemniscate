import { describe, expect, it } from 'vitest';

import { isSafeHttpUrl, prUrlHref } from './url';

// Locking tests for the API-derived URL guard: only http(s) URLs may be
// rendered as href/src — anything else (javascript:, data:, protocol-relative
// tricks, malformed input) is dropped.

describe('isSafeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isSafeHttpUrl('https://github.com/org/repo/pull/1')).toBe(true);
    expect(isSafeHttpUrl('http://gitlab.example.com/org/repo/-/merge_requests/2')).toBe(true);
  });

  it('rejects javascript: and data: URLs', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('  javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects other schemes and malformed input', () => {
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('ftp://example.com/x')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
  });
});

describe('prUrlHref', () => {
  it('passes http(s) URLs through unchanged', () => {
    expect(prUrlHref('https://github.com/org/repo/pull/1')).toBe('https://github.com/org/repo/pull/1');
  });

  it('resolves root-relative gitlem links against the app base', () => {
    // Vitest runs with BASE_URL='/' — the join is a no-op here, and becomes
    // '<base>/gitlem/...' when the SPA is built with a subpath base.
    expect(prUrlHref('/gitlem/repos/alice/demo/pulls/1')).toBe('/gitlem/repos/alice/demo/pulls/1');
  });

  it('rejects unsafe or malformed input', () => {
    expect(prUrlHref('javascript:alert(1)')).toBeNull();
    expect(prUrlHref('//evil.example.com/x')).toBeNull();
    expect(prUrlHref('not a url')).toBeNull();
    expect(prUrlHref('')).toBeNull();
  });
});
