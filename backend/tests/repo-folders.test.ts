import { describe, expect, it } from 'vitest';
import { filterFoldersBySearch, normalizeFolderPaths } from '../src/lib/repo-folders.js';

describe('normalizeFolderPaths', () => {
  it('returns root only for an empty tree', () => {
    expect(normalizeFolderPaths([])).toEqual(['/']);
  });

  it('normalizes, sorts and prefixes folders with a slash', () => {
    expect(normalizeFolderPaths(['src/api', 'docs', './src'])).toEqual([
      '/',
      '/docs',
      '/src',
      '/src/api',
    ]);
  });

  it('skips git internals and node_modules', () => {
    expect(normalizeFolderPaths(['.git', '.git/hooks', 'node_modules/react', 'src'])).toEqual([
      '/',
      '/src',
    ]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 50 }, (_, i) => `dir${i}`);
    expect(normalizeFolderPaths(many, 10)).toHaveLength(11); // cap + root
  });
});

describe('filterFoldersBySearch', () => {
  const folders = ['/', '/docs', '/src', '/src/api'];

  it('returns everything for a blank search', () => {
    expect(filterFoldersBySearch(folders, '  ')).toEqual(folders);
  });

  it('filters case-insensitively and always keeps root', () => {
    expect(filterFoldersBySearch(folders, 'API')).toEqual(['/', '/src/api']);
    expect(filterFoldersBySearch(folders, 'zzz')).toEqual(['/']);
  });
});
