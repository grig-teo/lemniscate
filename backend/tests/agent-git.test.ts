import { describe, expect, it } from 'vitest';
import { sanitizeRelativePath } from '../src/lib/agent-git.js';

// Locking tests for the LLM-path safety check extracted from agent-loop.ts.

describe('sanitizeRelativePath', () => {
  it('normalizes ordinary relative paths', () => {
    expect(sanitizeRelativePath('src/a.ts')).toBe('src/a.ts');
    expect(sanitizeRelativePath('a/./b')).toBe('a/b');
  });

  it('converts backslashes to forward slashes', () => {
    expect(sanitizeRelativePath('src\\a.ts')).toBe('src/a.ts');
  });

  it.each(['/abs/path', '..', '../escape', 'a/../../b', '.', '.git', '.git/config'])(
    'rejects unsafe path %s',
    (raw) => {
      expect(() => sanitizeRelativePath(raw)).toThrow(`LLM proposed an unsafe file path: ${raw}`);
    },
  );
});
