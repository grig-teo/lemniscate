import { assertPublicHttpUrl } from './url-safety.js';

// URL gates for the agent job context (clone URL + LLM baseUrl). Extracted
// from agent-runtime.ts.

// Clone URL gate: https-only and publicly routable, checked before any token
// is decrypted or any clone runs — a stored cloneUrl must never turn the
// worker into an SSRF client (or read local services via file/http).
export async function assertSafeCloneUrl(cloneUrl: string): Promise<void> {
  const url = await assertPublicHttpUrl(cloneUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`repository cloneUrl must use https (got ${url.protocol})`);
  }
}

// LLM endpoint gate: the saved-config baseUrl is asserted once here, at
// runtime construction — not on the per-request hot path in llm-client.ts.
export async function assertSafeLlmBaseUrl(baseUrl: string): Promise<void> {
  await assertPublicHttpUrl(baseUrl).catch((err: unknown) => {
    throw new Error(`LLM baseUrl is not allowed: ${(err as Error).message}`);
  });
}
