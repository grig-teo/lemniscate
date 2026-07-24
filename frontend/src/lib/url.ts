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
