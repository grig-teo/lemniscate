import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '../src/lib/llm-client.js';
import { anthropicMessages, toAnthropicRequest } from '../src/lib/llm-anthropic.js';

// Locking tests for the Anthropic Messages-API client (the second provider
// pattern). fetch is stubbed; the API key must never leak into errors.

const API_KEY = 'sk-ant-secret';
const BASE = {
  baseUrl: 'https://api.anthropic.com/',
  apiKey: API_KEY,
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 16,
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

function messageResponse(text: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toAnthropicRequest', () => {
  it('extracts system messages into the top-level system param', () => {
    const req = toAnthropicRequest([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'a' },
      { role: 'system', content: 'be kind' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(req.system).toBe('be terse\n\nbe kind');
    expect(req.messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });

  it('converts image data URLs to base64 image blocks', () => {
    const req = toAnthropicRequest([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      },
    ]);
    expect(req.messages[0]?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('passes remote image URLs through as url sources', () => {
    const req = toAnthropicRequest([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
      },
    ]);
    expect(req.messages[0]?.content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
    ]);
  });

  it('maps assistant tool_calls to tool_use and tool results to tool_result', () => {
    const req = toAnthropicRequest([
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: 'a.ts\nb.ts' },
    ]);
    expect(req.messages).toHaveLength(3);
    expect(req.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    expect(req.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.ts\nb.ts' }],
    });
  });
});

describe('anthropicMessages tools', () => {
  it('sends tools in the Anthropic input_schema shape and parses tool_use', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'bash',
          description: 'run',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
    ];
    const calls = stubFetch(
      jsonResponse({
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'x1', name: 'bash', input: { command: 'pwd' } },
        ],
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    const result = await anthropicMessages({ ...BASE, tools });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.tools).toEqual([
      {
        name: 'bash',
        description: 'run',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ]);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls?.[0]).toEqual({
      id: 'x1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"pwd"}' },
    });
  });
});

describe('anthropicMessages', () => {
  it('posts to <baseUrl>/v1/messages with x-api-key + anthropic-version', async () => {
    const calls = stubFetch(jsonResponse(messageResponse('hello')));
    const result = await anthropicMessages({ ...BASE, temperature: 0.5 });
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({
      model: 'claude-sonnet-4-5',
      messages: BASE.messages,
      max_tokens: 16,
      temperature: 0.5,
    });
    expect(result.content).toBe('hello');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('concatenates multiple text blocks', async () => {
    stubFetch(
      jsonResponse(
        messageResponse('one', {
          content: [
            { type: 'text', text: 'one' },
            { type: 'text', text: 'two' },
          ],
        }),
      ),
    );
    const result = await anthropicMessages(BASE);
    expect(result.content).toBe('one\ntwo');
  });

  it('throws a scrubbed LlmError on HTTP failures', async () => {
    stubFetch(jsonResponse({ error: { message: `bad key ${API_KEY}` } }, 401));
    const err = await anthropicMessages(BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).status).toBe(401);
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it('treats stop_reason max_tokens as truncated (error unless allowTruncated)', async () => {
    stubFetch(
      jsonResponse(messageResponse('cut', { stop_reason: 'max_tokens' })),
      jsonResponse(messageResponse('cut', { stop_reason: 'max_tokens' })),
    );
    await expect(anthropicMessages(BASE)).rejects.toThrow(/truncated/i);
    const result = await anthropicMessages({ ...BASE, allowTruncated: true });
    expect(result.truncated).toBe(true);
    expect(result.content).toBe('cut');
  });

  it('reports response headers via onResponseHeaders (quota snapshot)', async () => {
    stubFetch(
      jsonResponse(messageResponse('ok'), 200, {
        'anthropic-ratelimit-unified-5h-remaining': '42',
      }),
    );
    const seen: Headers[] = [];
    await anthropicMessages({ ...BASE, onResponseHeaders: (headers) => seen.push(headers) });
    expect(seen[0]?.get('anthropic-ratelimit-unified-5h-remaining')).toBe('42');
  });

  it('retries a 529 overload once then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const calls = stubFetch(
        jsonResponse({ error: { message: 'overloaded' } }, 529),
        jsonResponse(messageResponse('recovered')),
      );
      const pending = anthropicMessages({ ...BASE, maxRetries: 1 });
      const assertion = expect(pending).resolves.toMatchObject({ content: 'recovered' });
      await vi.runAllTimersAsync();
      await assertion;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
