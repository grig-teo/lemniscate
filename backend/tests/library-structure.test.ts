import { describe, expect, it } from 'vitest';
import { sanitizeStructureFolders } from '../src/routes/library.js';

describe('sanitizeStructureFolders', () => {
  it('returns root only for garbage input', () => {
    expect(sanitizeStructureFolders(null)).toEqual(['/']);
    expect(sanitizeStructureFolders({})).toEqual(['/']);
    expect(sanitizeStructureFolders({ folders: 'src' })).toEqual(['/']);
  });

  it('normalizes folders to slash-prefixed paths and keeps root first', () => {
    expect(sanitizeStructureFolders({ folders: ['src', 'src/api', '/docs/'] })).toEqual([
      '/',
      '/src',
      '/src/api',
      '/docs',
    ]);
  });

  it('drops traversal, files and non-string entries', () => {
    expect(
      sanitizeStructureFolders({ folders: ['../evil', 'src/../x', 'README.md', 42, 'src'] }),
    ).toEqual(['/', '/src']);
  });

  it('dedupes and caps at 30 folders', () => {
    const many = Array.from({ length: 40 }, (_, i) => `dir${i % 35}`);
    const result = sanitizeStructureFolders({ folders: many });
    expect(result.length).toBeLessThanOrEqual(30);
    expect(new Set(result).size).toBe(result.length);
  });
});
