/**
 * Minimal fetch wrapper for the Lemniscate backend.
 *
 * - Base URL comes from VITE_API_URL (empty string => same origin, which is
 *   what the Vite dev proxy and the production nginx /api proxy expect).
 * - Cookies are always sent (`credentials: 'include'`) for session auth.
 * - Errors are normalized into ApiError with an HTTP status and a
 *   human-readable message extracted from common backend error shapes.
 */

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

/** Absolute base URL of the backend (empty string = same origin). */
export const API_BASE_URL = BASE_URL;

/**
 * Full-page redirect target that starts an OAuth flow on the backend.
 * The flow ends back on `/` with the `lemniscate_token` cookie set.
 */
export function oauthStartUrl(provider: 'github' | 'gitlab'): string {
  return `${BASE_URL}/api/auth/${provider}`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

interface ZodIssueLike {
  path?: (string | number)[];
  message?: string;
}

function issueSummary(issue: ZodIssueLike): string {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
  return path ? `${path}: ${issue.message}` : String(issue.message);
}

/**
 * Human-readable error text: appends the server's zod validation issues
 * (sent as `details.issues` on 400s) so users see WHICH field failed.
 */
export function describeApiError(error: Error): string {
  if (!(error instanceof ApiError)) return error.message;
  const issues = (error.details as { issues?: ZodIssueLike[] } | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return error.message;
  const summary = issues.slice(0, 3).map(issueSummary).join('; ');
  return `${error.message} — ${summary}`;
}

type JsonBody = Record<string, unknown> | unknown[] | undefined;

async function parseErrorMessage(res: Response): Promise<{ message: string; details?: unknown }> {
  try {
    const data: unknown = await res.json();
    if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (typeof record.message === 'string' && record.message) {
        return { message: record.message, details: data };
      }
      if (typeof record.error === 'string' && record.error) {
        return { message: record.error, details: data };
      }
    }
    return { message: res.statusText || `Request failed with status ${res.status}`, details: data };
  } catch {
    return { message: res.statusText || `Request failed with status ${res.status}` };
  }
}

async function request<T>(method: string, path: string, body?: JsonBody): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const { message, details } = await parseErrorMessage(res);
    throw new ApiError(res.status, message, details);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : (undefined as T));
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: JsonBody) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: JsonBody) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
