// LLM provider/preset and rate-limit-quota types, split out of
// api-types.ts (AGENTS.md §2 file-size limit). Re-exported there, so
// existing importers keep their import path.

/** Transport pattern of an LLM config (mirrors backend lib/llm-providers.ts). */
export type LlmApiPattern = 'openai' | 'anthropic';

/**
 * Provider preset from GET /api/llm-configs/presets — the settings
 * "Add provider" flows seed the config form from these (OpenAI, Anthropic,
 * z.ai, Kimi/Moonshot, Grok/xAI).
 */
export type LlmProviderPreset = {
  id: string;
  label: string;
  pattern: LlmApiPattern;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  contextWindow: number;
  maxTokens: number;
  /** Which quota windows this provider can ever report (5h / weekly). */
  quota: { shortWindow: boolean; weekly: boolean };
};

/** One rate-limit window parsed from provider response headers. */
export type QuotaWindow = {
  /** Display label: '5-hour', 'weekly', 'per-minute (tokens)', … */
  label: string;
  limit: number | null;
  remaining: number | null;
  /** ISO reset timestamp; null when the provider does not state one. */
  resetsAt: string | null;
};

/** GET /api/llm-configs/:id/quota payload — null when nothing was recorded. */
export type LlmQuotaInfo = {
  pattern: LlmApiPattern;
  capturedAt: string;
  shortWindow: QuotaWindow | null;
  weekly: QuotaWindow | null;
};

