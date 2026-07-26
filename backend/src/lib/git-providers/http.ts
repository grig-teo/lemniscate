import { ProviderError } from './types.js';

// Shared HTTP plumbing for the per-provider clients. Same ProviderError
// contract everywhere: never leaks the token, carries the HTTP status.

export interface JsonMeta {
  data: unknown;
  headers: Headers;
}

export async function requestJsonMeta(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<JsonMeta> {
  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    throw new ProviderError(
      `${provider}: request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(
      `${provider}: ${response.status} ${response.statusText} from ${url}: ${body.slice(0, 300)}`,
      response.status,
    );
  }
  return { data: await response.json(), headers: response.headers };
}

export async function requestJson(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<unknown> {
  return (await requestJsonMeta(url, headers, provider)).data;
}

// POST/PUT variant of requestJson for the write endpoints. Same
// ProviderError contract: never leaks the token, carries the HTTP status.
export async function sendJson(
  method: 'POST' | 'PUT',
  url: string,
  headers: Record<string, string>,
  provider: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ProviderError(
      `${provider}: request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ProviderError(
      `${provider}: ${response.status} ${response.statusText} from ${method} ${url}: ${text.slice(0, 300)}`,
      response.status,
    );
  }
  return response.json();
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  provider: string,
  body: unknown,
): Promise<unknown> {
  return sendJson('POST', url, headers, provider, body);
}

// GitHub-shaped contents APIs take file content as base64.
export function base64Content(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}
