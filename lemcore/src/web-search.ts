// DuckDuckGo HTML search backend for lemcore web_search tool.
// No API key required. Returns up to MAX_RESULTS structured hits.

export const WEB_SEARCH_MAX_RESULTS = 8;
export const WEB_SEARCH_TIMEOUT_MS = 15_000;

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Exported for tests — parse DDG HTML result page into hits. */
export function parseDuckDuckGoHtml(html: string, max = WEB_SEARCH_MAX_RESULTS): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  // result__a anchors carry the title + href; result__snippet is nearby text.
  const anchorRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null && hits.length < max) {
    const href = decodeHtml(match[1] ?? '');
    const title = stripTags(decodeHtml(match[2] ?? '')).trim();
    if (!title || !href) continue;
    const url = unwrapDdgRedirect(href);
    if (!url.startsWith('http')) continue;
    const after = html.slice(match.index, match.index + 1200);
    const snipMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)/i.exec(
      after,
    );
    const snippet = snipMatch
      ? stripTags(decodeHtml(snipMatch[1] ?? '')).trim()
      : '';
    hits.push({ title, url, snippet });
  }
  return hits;
}

/** DDG wraps outbound links as //duckduckgo.com/l/?uddg=<encoded>. */
export function unwrapDdgRedirect(href: string): string {
  try {
    const absolute = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(absolute);
    if (parsed.hostname.includes('duckduckgo.com') && parsed.pathname === '/l/') {
      const target = parsed.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    return absolute;
  } catch {
    return href;
  }
}

export function formatWebSearchResults(query: string, hits: WebSearchHit[]): string {
  if (hits.length === 0) {
    return `No web results for: ${query}`;
  }
  const lines = hits.map((hit, i) => {
    const snip = hit.snippet ? `\n   ${hit.snippet}` : '';
    return `${i + 1}. ${hit.title}\n   ${hit.url}${snip}`;
  });
  return [`Web search results for: ${query}`, '', ...lines].join('\n');
}

export async function duckDuckGoSearch(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        // DDG HTML endpoint is picky about bare bots; a normal browser UA is enough.
        'user-agent':
          'Mozilla/5.0 (compatible; LemniscateLemcore/1.0; +https://github.com/grig-teo/lemniscate)',
        accept: 'text/html',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`DuckDuckGo HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseDuckDuckGoHtml(html);
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}
