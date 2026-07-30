// Maps raw worker/LLM error text (e.g. `LLM endpoint returned HTTP 403:
// {"code":"personal-team-blocked:spending-limit",...}`) to a short, readable
// sentence with a suggested next action for notification bodies. Only
// recognized provider-error shapes are rewritten — anything else passes
// through unchanged so existing, already-readable messages stay as-is.

const SETTINGS_HINT = 'Settings → LLM configurations';

// Extracts the HTTP status and the provider's human-readable message from
// shapes like `... HTTP 403: {"code":"x","error":"msg"}` (the `error` field
// may be a string or a nested object with its own `message`).
function parseHttpError(raw: string): { status: number | null; detail: string | null } {
  const statusMatch = /HTTP (\d{3})\b/.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  let detail: string | null = null;
  const jsonMatch = /\{.*\}/s.exec(raw);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      detail = digMessage(parsed);
    } catch {
      // provider body was not JSON — keep the raw text as the detail source
    }
  }
  return { status, detail };
}

// Depth-first search for the most descriptive string field: prefers
// `message`/`error` (string) over `code`/`type` across nesting levels.
function digMessage(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = digMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'msg']) {
    const field = record[key];
    if (typeof field === 'string' && field.length > 0) return field;
    if (field !== null && typeof field === 'object') {
      const nested = digMessage(field, depth + 1);
      if (nested) return nested;
    }
  }
  for (const key of ['code', 'type']) {
    const field = record[key];
    if (typeof field === 'string' && field.length > 0) return field;
  }
  return null;
}

export function friendlyErrorMessage(raw: string): string {
  const { status, detail } = parseHttpError(raw);
  const haystack = `${raw}\n${detail ?? ''}`.toLowerCase();

  if (
    haystack.includes('spending-limit') ||
    haystack.includes('out of credits') ||
    haystack.includes('insufficient credits') ||
    haystack.includes('insufficient_quota') ||
    haystack.includes('exceeded your current quota')
  ) {
    return `The LLM account is out of credits (spending limit reached). Top up the provider balance or switch to another model in ${SETTINGS_HINT}.`;
  }
  if (
    status === 401 ||
    haystack.includes('invalid api key') ||
    haystack.includes('api key appears to be invalid') ||
    haystack.includes('incorrect api key') ||
    haystack.includes('token expired or incorrect') ||
    haystack.includes('autherror')
  ) {
    return `The LLM provider rejected the API key. Update or re-create the key in ${SETTINGS_HINT}.`;
  }
  if (haystack.includes('unknown model') || haystack.includes('model does not exist')) {
    return `The provider doesn't recognize the configured model name. Check the model field in ${SETTINGS_HINT}.`;
  }
  if (status === 403) {
    return `The LLM provider refused the request (HTTP 403) — the key likely lacks permissions. Check it in ${SETTINGS_HINT}.`;
  }
  if (status === 404) {
    return `The LLM endpoint or model was not found (HTTP 404). Check the base URL and model in ${SETTINGS_HINT}.`;
  }
  if (status === 429 || haystack.includes('rate limit')) {
    return 'The LLM provider rate-limited the request. The run retries automatically; consider lowering requests-per-minute in Settings → LLM configurations.';
  }
  if (status !== null && status >= 500) {
    return `The LLM provider is experiencing server errors (HTTP ${status}). The run retries automatically.`;
  }
  if (
    haystack.includes('timed out') ||
    haystack.includes('etimedout') ||
    haystack.includes('econnrefused') ||
    haystack.includes('econnreset') ||
    haystack.includes('enotfound') ||
    haystack.includes('fetch failed')
  ) {
    return `The LLM provider is unreachable or timed out. The run retries automatically; check the base URL in ${SETTINGS_HINT} if it persists.`;
  }
  if (status !== null && detail) {
    const short = detail.length > 140 ? `${detail.slice(0, 140)}…` : detail;
    return `The LLM provider returned HTTP ${status}: ${short}`;
  }
  // Not a recognized provider error — keep the original message untouched.
  return raw;
}
