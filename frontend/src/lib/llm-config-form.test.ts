import { describe, expect, it } from 'vitest';

import { buildPayload, DEFAULTS, fromConfig, fromPreset, type FormState } from '@/lib/llm-config-form';
import type { LlmConfig, LlmProviderPreset } from '@/lib/hooks';

const REQUIRED: FormState = {
  ...DEFAULTS,
  name: '  My config ',
  baseUrl: ' https://api.example.com/v1 ',
  model: ' gpt-x ',
};

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'c1',
    name: 'Cfg',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-x',
    hasApiKey: true,
    apiPattern: 'openai',
    provider: null,
    thinkingLevel: 'low',
    temperature: 0.2,
    maxTokens: 4096,
    contextWindow: 128000,
    systemPromptExtra: 'be terse',
    timeoutSeconds: 120,
    maxRetries: 3,
    requestsPerMinute: 60,
    maxTokensPerRun: 500000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
    customHeaders: { 'X-Org': 'team' },
    isDefault: true,
    enabled: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('fromConfig', () => {
  it('maps a saved config into string form state with a blank apiKey', () => {
    const form = fromConfig(makeConfig());
    expect(form).toEqual({
      name: 'Cfg',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      model: 'gpt-x',
      apiPattern: 'openai',
      provider: '',
      thinkingLevel: 'low',
      temperature: '0.2',
      maxTokens: '4096',
      contextWindow: '128000',
      systemPromptExtra: 'be terse',
      timeoutSeconds: '120',
      maxRetries: '3',
      requestsPerMinute: '60',
      maxTokensPerRun: '500000',
      inputPricePerMillion: '0.15',
      outputPricePerMillion: '0.6',
      customHeaders: JSON.stringify({ 'X-Org': 'team' }, null, 2),
      isDefault: true,
      enabled: false,
    });
  });

  it('maps null optional fields to empty strings', () => {
    const form = fromConfig(makeConfig({ systemPromptExtra: null, customHeaders: null }));
    expect(form.systemPromptExtra).toBe('');
    expect(form.customHeaders).toBe('');
  });
});

describe('fromPreset', () => {
  const anthropicPreset: LlmProviderPreset = {
    id: 'anthropic',
    label: 'Anthropic',
    pattern: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5'],
    contextWindow: 200_000,
    maxTokens: 8_192,
    quota: { shortWindow: true, weekly: true },
  };

  it('seeds the endpoint fields from the preset, leaving the API key blank', () => {
    const form = fromPreset(anthropicPreset);
    expect(form).toMatchObject({
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      apiPattern: 'anthropic',
      provider: 'anthropic',
      apiKey: '',
      maxTokens: '8192',
      contextWindow: '200000',
      requestsPerMinute: '60',
    });
  });

  it('produces a payload carrying apiPattern and provider once the key is typed', () => {
    const built = buildPayload({ ...fromPreset(anthropicPreset), apiKey: 'sk-ant' });
    expect(built).toHaveProperty('payload');
    if ('payload' in built) {
      expect(built.payload.apiPattern).toBe('anthropic');
      expect(built.payload.provider).toBe('anthropic');
      expect(built.payload.apiKey).toBe('sk-ant');
    }
  });

  it('omits provider for custom endpoints', () => {
    const built = buildPayload(REQUIRED);
    if ('payload' in built) expect(built.payload.provider).toBeUndefined();
  });
});

describe('buildPayload', () => {
  it('trims required fields and carries defaults and booleans through', () => {
    const built = buildPayload({ ...REQUIRED, isDefault: true, enabled: false });
    expect(built).toEqual({
      payload: {
        name: 'My config',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-x',
        apiPattern: 'openai',
        thinkingLevel: 'off',
        temperature: 0.2,
        timeoutSeconds: 120,
        maxRetries: 3,
        isDefault: true,
        enabled: false,
      },
    });
  });

  it('rejects missing required fields', () => {
    expect(buildPayload(DEFAULTS)).toEqual({
      error: 'Name, base URL and model are required.',
    });
  });

  it('includes the apiKey only when typed', () => {
    const without = buildPayload(REQUIRED);
    expect(without).toHaveProperty('payload');
    if ('payload' in without) expect(without.payload.apiKey).toBeUndefined();

    const withKey = buildPayload({ ...REQUIRED, apiKey: 'sk-1' });
    if ('payload' in withKey) expect(withKey.payload.apiKey).toBe('sk-1');
  });

  it('parses numeric fields and skips blank ones', () => {
    const built = buildPayload({ ...REQUIRED, temperature: '0.7', maxTokens: '100', contextWindow: '' });
    if ('payload' in built) {
      expect(built.payload.temperature).toBe(0.7);
      expect(built.payload.maxTokens).toBe(100);
      expect(built.payload.contextWindow).toBeUndefined();
    }
  });

  it('passes fractional token prices through and skips blank ones', () => {
    const built = buildPayload({ ...REQUIRED, inputPricePerMillion: '0.15', outputPricePerMillion: '' });
    if ('payload' in built) {
      expect(built.payload.inputPricePerMillion).toBe(0.15);
      expect(built.payload.outputPricePerMillion).toBeUndefined();
    }
  });

  it('rejects non-numeric values naming the field', () => {
    expect(buildPayload({ ...REQUIRED, maxRetries: 'many' })).toEqual({
      error: '"maxRetries" must be a number.',
    });
  });

  it('includes a trimmed systemPromptExtra when present', () => {
    const blank = buildPayload({ ...REQUIRED, systemPromptExtra: '   ' });
    if ('payload' in blank) expect(blank.payload.systemPromptExtra).toBeUndefined();
    const set = buildPayload({ ...REQUIRED, systemPromptExtra: '  hi  ' });
    if ('payload' in set) expect(set.payload.systemPromptExtra).toBe('hi');
  });

  it('validates custom headers JSON', () => {
    expect(buildPayload({ ...REQUIRED, customHeaders: '{nope' })).toEqual({
      error: 'Custom headers must be valid JSON.',
    });
    expect(buildPayload({ ...REQUIRED, customHeaders: '[1]' })).toEqual({
      error: 'Custom headers must be a JSON object of key/value pairs.',
    });
    const ok = buildPayload({ ...REQUIRED, customHeaders: '{"X-A":"b"}' });
    if ('payload' in ok) expect(ok.payload.customHeaders).toEqual({ 'X-A': 'b' });
  });
});
