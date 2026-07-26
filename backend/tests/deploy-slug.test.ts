import { describe, expect, it } from 'vitest';
import { servicePath, slugify } from '../src/lib/deploy/slug.js';

// Pure slug helpers — no environment needed.

describe('slugify', () => {
  it('lowercases and keeps [a-z0-9-]', () => {
    expect(slugify('My-App_2')).toBe('my-app-2');
    expect(slugify('grig-teo')).toBe('grig-teo');
  });

  it('replaces separators with single dashes and trims them', () => {
    expect(slugify('  hello world!! ')).toBe('hello-world');
    expect(slugify('--a__b--c--')).toBe('a-b-c');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('caps at 63 chars without a trailing dash', () => {
    const slug = slugify(`a${'-b'.repeat(40)}`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('servicePath', () => {
  it('builds /<owner>/<name> from slugified segments', () => {
    expect(servicePath('Grig-Teo', 'My App')).toBe('/grig-teo/my-app');
  });

  it('rejects empty segments', () => {
    expect(() => servicePath('!!!', 'app')).toThrow();
    expect(() => servicePath('owner', '')).toThrow();
  });
});
