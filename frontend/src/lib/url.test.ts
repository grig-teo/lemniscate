import { describe, expect, it } from 'vitest';

import { isSafeHttpUrl } from './url';

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
