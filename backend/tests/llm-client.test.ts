import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backoffMs,
  chatCompletions,
  LlmError,
  toReasoningEffort,
} from '../src/lib/llm-client.js';

// Locking tests for the OpenAI-compatible chat client. fetch is stubbed;
// no network is touched. apiKey 'sk-secret' must never appear in errors.

const API_KEY = 'sk-secret';
const BASE = {
  baseUrl: 'https://llm.example.com/v1/',
  apiKey: API_KEY,
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxRetries: 0,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function stubFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next as Response;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chatCompletions', () => {
  it('posts to <baseUrl>/chat/completions with the Bearer key and parses the result', async () => {
    const calls = stubFetch(
      jsonResponse({
        choices: [{ message: { content: 'hello' } }],
        model: 'echo-model',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    const result = await chatCompletions({ ...BASE, temperature: 0.5, maxTokens: 16 });
    expect(calls[0]?.url).toBe('https://llm.example.com/v1/chat/completions');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({ model: 'test-model', messages: BASE.messages, temperature: 0.5, max_tokens: 16 });
    expect(result.content).toBe('hello');
    expect(result.model).toBe('echo-model');
    expect(result.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('omits usage when the endpoint does not report it', async () => {
    stubFetch(jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    const result = await chatCompletions(BASE);
    expect(result.model).toBe('test-model');
    expect(result.usage).toBeUndefined();
  });

  it('drops reasoning_effort transparently on HTTP 400 and retries without it', async () => {
    const calls = stubFetch(
      jsonResponse({ error: 'unknown field' }, 400),
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const result = await chatCompletions({ ...BASE, thinkingLevel: 'low' });
    expect(result.content).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init.body)).reasoning_effort).toBe('low');
    expect(JSON.parse(String(calls[1]?.init.body)).reasoning_effort).toBeUndefined();
  });

  it('maps thinkingLevel max to reasoning_effort xhigh', async () => {
    const calls = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await chatCompletions({ ...BASE, thinkingLevel: 'max' });
    expect(JSON.parse(String(calls[0]?.init.body)).reasoning_effort).toBe('xhigh');
  });

  it('passes multimodal content parts through to the request body', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'what is in this image?' },
          { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ];
    const calls = stubFetch(jsonResponse({ choices: [{ message: { content: 'a cat' } }] }));
    const result = await chatCompletions({ ...BASE, messages });
    expect(result.content).toBe('a cat');
    expect(JSON.parse(String(calls[0]?.init.body)).messages).toEqual(messages);
  });

  it('throws an http LlmError with the apiKey scrubbed from the body', async () => {
    stubFetch(jsonResponse({ detail: `bad key ${API_KEY} here` }, 401));
    const err = await chatCompletions(BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    const llmErr = err as LlmError;
    expect(llmErr.kind).toBe('http');
    expect(llmErr.status).toBe(401);
    expect(llmErr.message).toContain('[redacted]');
    expect(llmErr.message).not.toContain(API_KEY);
  });

  it('retries 429 honoring retry-after, then succeeds', async () => {
    const calls = stubFetch(
      jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' }),
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const result = await chatCompletions({ ...BASE, maxRetries: 1 });
    expect(result.content).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('throws a network LlmError after exhausting retries on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`dial failed for ${API_KEY}`);
      }),
    );
    const err = await chatCompletions(BASE).catch((e: unknown) => e);
    const llmErr = err as LlmError;
    expect(llmErr.kind).toBe('network');
    expect(llmErr.message).not.toContain(API_KEY);
    expect(llmErr.message).toContain('[redacted]');
  });

  it('throws a protocol LlmError on invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    const err = await chatCompletions(BASE).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe('protocol');
    expect((err as LlmError).message).toMatch(/invalid JSON/);
  });

  it('throws a protocol LlmError when content is missing', async () => {
    stubFetch(jsonResponse({ choices: [{}] }));
    const err = await chatCompletions(BASE).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe('protocol');
    expect((err as LlmError).message).toMatch(/missing choices\[0\]\.message\.content/);
  });

  it('throws a protocol LlmError naming maxTokens when finish_reason is length', async () => {
    stubFetch(
      jsonResponse({
        choices: [{ message: { content: '{"summary": "partial' }, finish_reason: 'length' }],
      }),
    );
    const err = await chatCompletions({ ...BASE, maxTokens: 512 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('protocol');
    expect((err as LlmError).message).toContain('maxTokens=512');
    expect((err as LlmError).message).toMatch(/raise maxTokens in the LLM config/);
  });

  it('reports the real attempt number in the timeout message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const err = await chatCompletions({ ...BASE, maxRetries: 1, timeoutSeconds: 0 }).catch(
      (e: unknown) => e,
    );
    expect((err as LlmError).kind).toBe('timeout');
    expect((err as LlmError).message).toBe('Request timed out after 0s (attempt 2 of 2)');
  });

  it('calls onRetry with attempt info before each backoff wait', async () => {
    stubFetch(
      jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' }),
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const infos: { attempt: number; maxAttempts: number; delayMs: number; reason: string }[] = [];
    const result = await chatCompletions({
      ...BASE,
      maxRetries: 1,
      onRetry: (info) => infos.push(info),
    });
    expect(result.content).toBe('ok');
    expect(infos).toEqual([{ attempt: 1, maxAttempts: 2, delayMs: 0, reason: 'HTTP 429' }]);
  });

  it('reports network errors to onRetry before retrying', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      }),
    );
    const infos: { attempt: number; maxAttempts: number; delayMs: number; reason: string }[] = [];
    await chatCompletions({ ...BASE, maxRetries: 1, onRetry: (info) => infos.push(info) });
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ attempt: 1, maxAttempts: 2, reason: 'network error' });
    expect(infos[0]?.delayMs).toBeGreaterThan(0);
  });

  it('never calls onRetry when the first attempt succeeds', async () => {
    stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const onRetry = vi.fn();
    await chatCompletions({ ...BASE, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('toReasoningEffort', () => {
  it('passes low/medium/high through unchanged', () => {
    expect(toReasoningEffort('low')).toBe('low');
    expect(toReasoningEffort('medium')).toBe('medium');
    expect(toReasoningEffort('high')).toBe('high');
  });

  it('maps max to xhigh', () => {
    expect(toReasoningEffort('max')).toBe('xhigh');
  });
});

describe('backoffMs', () => {
  it('honors a numeric retry-after header in seconds, capped at 10s', () => {
    expect(backoffMs(0, '2')).toBe(2000);
    expect(backoffMs(0, '999')).toBe(10_000);
  });

  it('falls back to exponential backoff with jitter', () => {
    for (let i = 0; i < 20; i += 1) {
      const ms = backoffMs(1, null);
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThan(1500);
    }
  });
});
