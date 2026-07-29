import { describe, expect, it } from 'vitest';
import {
  apiPatternOf,
  findProviderPreset,
  LLM_PROVIDER_PRESETS,
  parseApiPattern,
} from '../src/lib/llm-providers.js';

// Locking tests for the LLM provider registry: the two integration patterns
// (OpenAI-compatible chat completions, Anthropic Messages) and the preset
// list. New OpenAI-compatible providers must be configuration, not new code.

describe('parseApiPattern', () => {
  it('accepts the two supported patterns', () => {
    expect(parseApiPattern('openai')).toBe('openai');
    expect(parseApiPattern('anthropic')).toBe('anthropic');
  });

  it('falls back to openai for missing/unknown values (rows predating the column)', () => {
    expect(parseApiPattern(undefined)).toBe('openai');
    expect(parseApiPattern(null)).toBe('openai');
    expect(parseApiPattern('azure')).toBe('openai');
  });
});

describe('apiPatternOf', () => {
  it('reads the pattern off a config row, defaulting to openai', () => {
    expect(apiPatternOf({ apiPattern: 'anthropic' })).toBe('anthropic');
    expect(apiPatternOf({ apiPattern: 'openai' })).toBe('openai');
    expect(apiPatternOf({})).toBe('openai');
  });
});

describe('LLM_PROVIDER_PRESETS', () => {
  it('offers first-class OpenAI and Anthropic presets', () => {
    const openai = findProviderPreset('openai');
    const anthropic = findProviderPreset('anthropic');
    expect(openai?.pattern).toBe('openai');
    expect(openai?.baseUrl).toBe('https://api.openai.com/v1');
    expect(anthropic?.pattern).toBe('anthropic');
    expect(anthropic?.baseUrl).toBe('https://api.anthropic.com');
  });

  it('covers z.ai, Kimi/Moonshot and Grok/xAI via the OpenAI pattern', () => {
    for (const id of ['zai', 'kimi', 'grok']) {
      const preset = findProviderPreset(id);
      expect(preset, id).toBeDefined();
      expect(preset?.pattern).toBe('openai');
      expect(preset?.baseUrl).toMatch(/^https:\/\//);
      expect(preset?.models.length).toBeGreaterThan(0);
    }
  });

  it('defaults Grok coding model to grok-4.5 and supports OAuth connect', () => {
    const grok = findProviderPreset('grok');
    expect(grok?.defaultModel).toBe('grok-4.5');
    expect(grok?.models).toContain('grok-4.5');
    expect(grok?.supportsOauth).toBe(true);
  });

  it('every preset is well-formed (label, default model in list, sane windows)', () => {
    expect(LLM_PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const preset of LLM_PROVIDER_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.models).toContain(preset.defaultModel);
      expect(preset.contextWindow).toBeGreaterThan(0);
      expect(preset.maxTokens).toBeGreaterThan(0);
      expect(preset.maxTokens).toBeLessThanOrEqual(preset.contextWindow);
      expect(['openai', 'anthropic']).toContain(preset.pattern);
    }
  });

  it('preset ids are unique', () => {
    const ids = LLM_PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns undefined for unknown preset ids', () => {
    expect(findProviderPreset('nope')).toBeUndefined();
  });
});
