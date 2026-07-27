// LLM provider registry — the single home for the two integration patterns
// and the first-class provider presets.
//
// Two transport patterns exist in the codebase:
//   1. 'openai'     — chat-completions style (POST <baseUrl>/chat/completions,
//                     Bearer key, `model` param). Covers OpenAI itself plus
//                     every OpenAI-compatible endpoint (z.ai, Kimi/Moonshot,
//                     Grok/xAI, vLLM, Ollama, …). Client: llm-client.ts.
//   2. 'anthropic'  — Messages API (POST <baseUrl>/v1/messages, x-api-key +
//                     anthropic-version headers, `max_tokens` required).
//                     Client: llm-anthropic.ts.
//
// Adding another OpenAI-compatible provider is a preset row here, never new
// code (AGENTS.md §6).

export type LlmApiPattern = 'openai' | 'anthropic';

export interface LlmProviderPreset {
  /** Stable id stored on LlmConfig.provider ('openai', 'anthropic', …). */
  id: string;
  /** Display label for the settings UI. */
  label: string;
  pattern: LlmApiPattern;
  baseUrl: string;
  defaultModel: string;
  /** Suggested model ids; the default must be one of them. */
  models: string[];
  contextWindow: number;
  maxTokens: number;
  /**
   * Which rate-limit signals this provider is known to expose; the console
   * footer hides windows that can never have data instead of showing "n/a".
   */
  quota: {
    /** ~5-hour short window (Anthropic unified 5h headers, z.ai quota). */
    shortWindow: boolean;
    /** Weekly window (Anthropic unified 7d headers). */
    weekly: boolean;
  };
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    pattern: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3', 'gpt-4.1'],
    contextWindow: 128_000,
    maxTokens: 16_384,
    // x-ratelimit-* headers expose per-minute windows only — no 5h/weekly.
    quota: { shortWindow: false, weekly: false },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    pattern: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    contextWindow: 200_000,
    maxTokens: 8_192,
    // anthropic-ratelimit-* headers; unified 5h/7d windows where available.
    quota: { shortWindow: true, weekly: true },
  },
  {
    id: 'zai',
    label: 'z.ai',
    pattern: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.2',
    models: ['glm-5.2', 'glm-4.6', 'glm-4.5-air'],
    contextWindow: 200_000,
    maxTokens: 8_192,
    // Quota errors carry a "reset at" timestamp; no public headers yet.
    quota: { shortWindow: true, weekly: false },
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    pattern: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2-0905-preview', 'moonshot-v1-128k'],
    contextWindow: 256_000,
    maxTokens: 8_192,
    quota: { shortWindow: false, weekly: false },
  },
  {
    id: 'grok',
    label: 'Grok (xAI)',
    pattern: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    models: ['grok-4', 'grok-4-fast', 'grok-3-mini'],
    contextWindow: 256_000,
    maxTokens: 8_192,
    quota: { shortWindow: false, weekly: false },
  },
];

export function findProviderPreset(id: string): LlmProviderPreset | undefined {
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Parse a stored pattern value; unknown/missing degrades to 'openai'. */
export function parseApiPattern(raw: unknown): LlmApiPattern {
  return raw === 'anthropic' ? 'anthropic' : 'openai';
}

/** Pattern of a config row (rows predating the column read as 'openai'). */
export function apiPatternOf(configRecord: { apiPattern?: string | null }): LlmApiPattern {
  return parseApiPattern(configRecord.apiPattern);
}
