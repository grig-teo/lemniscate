import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion } from '../src/lib/llm-dispatch.js';

// Locking tests for the pattern dispatch: one entry point that routes a chat
// call to the OpenAI-compatible client or the Anthropic Messages client
// based on the config's apiPattern.

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
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

const BASE = {
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'sk-test',
  model: 'some-model',
  messages: [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' },
  ],
  maxRetries: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chatCompletion dispatch', () => {
  it('routes openai-pattern configs to the chat-completions client', async () => {
    const calls = stubFetch(
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const result = await chatCompletion({ ...BASE, apiPattern: 'openai' });
    expect(calls[0]?.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(result.content).toBe('ok');
  });

  it('defaults to the openai pattern when apiPattern is unset', async () => {
    const calls = stubFetch(
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    await chatCompletion(BASE);
    expect(calls[0]?.url).toBe('https://llm.example.com/v1/chat/completions');
  });

  it('routes anthropic-pattern configs to the Messages client (system extracted)', async () => {
    const calls = stubFetch(
      jsonResponse({
        content: [{ type: 'text', text: 'bonjour' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    );
    const result = await chatCompletion({ ...BASE, apiPattern: 'anthropic', maxTokens: 32 });
    // baseUrl already ends in /v1 → '/messages' is appended (no /v1/v1).
    expect(calls[0]?.url).toBe('https://llm.example.com/v1/messages');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.max_tokens).toBe(32);
    expect(result.content).toBe('bonjour');
    expect(result.usage?.totalTokens).toBe(6);
  });

  it('applies a default max_tokens for anthropic when the caller omits one', async () => {
    const calls = stubFetch(
      jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }),
    );
    await chatCompletion({ ...BASE, apiPattern: 'anthropic' });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('drops the openai-only thinkingLevel for anthropic calls', async () => {
    const calls = stubFetch(
      jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }),
    );
    await chatCompletion({ ...BASE, apiPattern: 'anthropic', thinkingLevel: 'high' });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('clamps temperature into the anthropic [0, 1] range', async () => {
    // The shared LlmConfig schema allows 0..2 (valid for OpenAI-compatible
    // endpoints); Anthropic rejects > 1 with a 400 on every call.
    const calls = stubFetch(
      jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }),
    );
    await chatCompletion({ ...BASE, apiPattern: 'anthropic', temperature: 1.8 });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.temperature).toBe(1);
  });

  it('keeps an in-range temperature unchanged for anthropic calls', async () => {
    const calls = stubFetch(
      jsonResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }),
    );
    await chatCompletion({ ...BASE, apiPattern: 'anthropic', temperature: 0.5 });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.temperature).toBe(0.5);
  });

  it('does not clamp temperature for openai-pattern calls', async () => {
    const calls = stubFetch(
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    await chatCompletion({ ...BASE, apiPattern: 'openai', temperature: 1.8 });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.temperature).toBe(1.8);
  });
});
