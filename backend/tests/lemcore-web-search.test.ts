import { describe, expect, it, vi } from 'vitest';

import {
  formatWebSearchResults,
  parseDuckDuckGoHtml,
  unwrapDdgRedirect,
  duckDuckGoSearch,
} from '../src/lib/lemcore/web-search.js';

const SAMPLE_HTML = `
<html><body>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First <b>Hit</b></a>
  <a class="result__snippet" href="#">Snippet one about TypeScript tools.</a>
  <a class="result__a" href="https://docs.example.org/guide">Second Hit</a>
  <td class="result__snippet">Official guide docs.</td>
  <a class="result__a" href="/relative">Skip me</a>
</body></html>
`;

describe('unwrapDdgRedirect', () => {
  it('unwraps DDG redirect links', () => {
    expect(
      unwrapDdgRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath'),
    ).toBe('https://example.com/path');
  });

  it('passes through normal https urls', () => {
    expect(unwrapDdgRedirect('https://example.com')).toBe('https://example.com');
  });
});

describe('parseDuckDuckGoHtml', () => {
  it('extracts title, url, and snippet up to the max', () => {
    const hits = parseDuckDuckGoHtml(SAMPLE_HTML, 8);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]).toMatchObject({
      title: 'First Hit',
      url: 'https://example.com/a',
    });
    expect(hits[0]?.snippet).toMatch(/Snippet one/i);
    expect(hits[1]?.url).toBe('https://docs.example.org/guide');
  });

  it('returns empty for empty html', () => {
    expect(parseDuckDuckGoHtml('')).toEqual([]);
  });
});

describe('formatWebSearchResults', () => {
  it('formats numbered results for the model', () => {
    const text = formatWebSearchResults('ts tools', [
      { title: 'A', url: 'https://a.example', snippet: 'alpha' },
      { title: 'B', url: 'https://b.example', snippet: '' },
    ]);
    expect(text).toContain('Web search results for: ts tools');
    expect(text).toContain('1. A');
    expect(text).toContain('https://a.example');
    expect(text).toContain('alpha');
    expect(text).toContain('2. B');
  });

  it('handles no hits', () => {
    expect(formatWebSearchResults('zzz', [])).toBe('No web results for: zzz');
  });
});

describe('duckDuckGoSearch', () => {
  it('fetches HTML and parses hits', async () => {
    const fetchImpl = vi.fn(async () => new Response(SAMPLE_HTML, { status: 200 }));
    const hits = await duckDuckGoSearch('typescript', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('html.duckduckgo.com/html/');
    expect(calledUrl).toContain('q=typescript');
    expect(hits[0]?.title).toBe('First Hit');
  });

  it('throws on non-OK HTTP', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(
      duckDuckGoSearch('x', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 503/);
  });
});
