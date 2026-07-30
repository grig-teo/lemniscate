import { describe, expect, it } from 'vitest';
import { friendlyErrorMessage } from '../src/lib/friendly-error.js';

// Locks the user-facing wording for recognized LLM/provider errors (shown in
// the notification bell) and the pass-through rule for everything else.

describe('friendlyErrorMessage', () => {
  it('maps a Grok-style spending-limit 403 to a credits message', () => {
    const raw =
      'LLM endpoint returned HTTP 403: {"code":"personal-team-blocked:spending-limit","error":"You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok."}';
    expect(friendlyErrorMessage(raw)).toBe(
      'The LLM account is out of credits (spending limit reached). Top up the provider balance or switch to another model in Settings → LLM configurations.',
    );
  });

  it('maps a 401 invalid-key body to a key-update message', () => {
    const raw =
      'LLM endpoint returned HTTP 401: {"error":{"message":"The API Key appears to be invalid or may have expired. Please verify your credentials and try again.","type":"invalid_request_error"}}';
    expect(friendlyErrorMessage(raw)).toBe(
      'The LLM provider rejected the API key. Update or re-create the key in Settings → LLM configurations.',
    );
  });

  it('maps nested provider auth errors (OpenCode AuthError shape)', () => {
    const raw =
      'LLM endpoint returned HTTP 401: {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}';
    expect(friendlyErrorMessage(raw)).toContain('rejected the API key');
  });

  it('maps an incorrect-key 400 (xAI shape) to the key message, not the model one', () => {
    const raw =
      'LLM endpoint returned HTTP 400: {"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}';
    expect(friendlyErrorMessage(raw)).toContain('rejected the API key');
  });

  it('maps an unknown-model error to a model-name message', () => {
    const raw =
      'LLM endpoint returned HTTP 400: {"error":{"code":"1211","message":"Unknown Model, please check the model code."}}';
    expect(friendlyErrorMessage(raw)).toBe(
      "The provider doesn't recognize the configured model name. Check the model field in Settings → LLM configurations.",
    );
  });

  it('maps a plain 403 to a permissions message', () => {
    const raw = 'LLM endpoint returned HTTP 403: {"error":"forbidden"}';
    expect(friendlyErrorMessage(raw)).toContain('HTTP 403');
    expect(friendlyErrorMessage(raw)).toContain('lacks permissions');
  });

  it('maps a 429 to a rate-limit message', () => {
    const raw = 'LLM endpoint returned HTTP 429: {"error":{"message":"Rate limit reached"}}';
    expect(friendlyErrorMessage(raw)).toContain('rate-limited');
  });

  it('maps a 5xx to a provider-outage message', () => {
    const raw = 'LLM endpoint returned HTTP 502: Bad Gateway';
    expect(friendlyErrorMessage(raw)).toBe(
      'The LLM provider is experiencing server errors (HTTP 502). The run retries automatically.',
    );
  });

  it('maps timeouts and network failures to an unreachable message', () => {
    expect(friendlyErrorMessage('Request timed out after 120s (4 attempts)')).toContain(
      'unreachable or timed out',
    );
    expect(friendlyErrorMessage('fetch failed: connect ECONNREFUSED 10.0.0.1:443')).toContain(
      'unreachable or timed out',
    );
  });

  it('keeps an unrecognized HTTP error readable with the provider detail', () => {
    const raw = 'LLM endpoint returned HTTP 400: {"error":{"message":"context length exceeded"}}';
    expect(friendlyErrorMessage(raw)).toBe(
      'The LLM provider returned HTTP 400: context length exceeded',
    );
  });

  it('passes non-LLM messages through unchanged', () => {
    expect(friendlyErrorMessage('boom')).toBe('boom');
    expect(friendlyErrorMessage('LLM connection refused')).toBe('LLM connection refused');
    expect(friendlyErrorMessage('budget exceeded (10 > 5)')).toBe('budget exceeded (10 > 5)');
    expect(friendlyErrorMessage('git push failed: remote rejected')).toBe(
      'git push failed: remote rejected',
    );
  });
});
