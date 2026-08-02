// Guard for API-derived URLs rendered into href/src attributes: only
// http(s) passes, so a malicious or buggy API payload cannot smuggle a
// javascript:/data: URL into a clickable link. Single home — import this
// wherever a server-supplied URL is rendered.

/** True when `raw` parses as an http: or https: URL. */
export function isSafeHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || url.protocol === 'http:';
}

/**
 * Resolve an API-supplied PR URL to a safe href: http(s) passes through and
 * root-relative paths (the internal gitlem host links, e.g.
 * /gitlem/repos/o/r/pulls/1) are prefixed with the app base so they work when
 * the SPA is served under a subpath. Anything else (javascript:, data:,
 * protocol-relative, malformed) is rejected with null.
 */
export function prUrlHref(raw: string): string | null {
  if (isSafeHttpUrl(raw)) return raw;
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    return `${import.meta.env.BASE_URL.replace(/\/$/, '')}${raw}`;
  }
  return null;
}
