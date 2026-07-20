/**
 * Form state and payload builder for the LLM config add/edit form.
 * The form keeps every value as a string (except booleans); buildPayload
 * validates and converts into the API payload shape.
 */
import type { LlmConfig, LlmConfigPayload, ThinkingLevel } from '@/lib/hooks';

export type FormState = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  temperature: string;
  maxTokens: string;
  contextWindow: string;
  systemPromptExtra: string;
  timeoutSeconds: string;
  maxRetries: string;
  requestsPerMinute: string;
  maxTokensPerRun: string;
  customHeaders: string;
  isDefault: boolean;
  enabled: boolean;
};

export const DEFAULTS: FormState = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  thinkingLevel: 'off',
  temperature: '0.2',
  maxTokens: '',
  contextWindow: '',
  systemPromptExtra: '',
  timeoutSeconds: '120',
  maxRetries: '3',
  requestsPerMinute: '',
  maxTokensPerRun: '',
  customHeaders: '',
  isDefault: false,
  enabled: true,
};

export type NumericField =
  | 'temperature'
  | 'maxTokens'
  | 'contextWindow'
  | 'timeoutSeconds'
  | 'maxRetries'
  | 'requestsPerMinute'
  | 'maxTokensPerRun';

export const NUMERIC_FIELDS: NumericField[] = [
  'temperature',
  'maxTokens',
  'contextWindow',
  'timeoutSeconds',
  'maxRetries',
  'requestsPerMinute',
  'maxTokensPerRun',
];

function numToInput(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Map a saved config into form state; the stored API key stays blank. */
export function fromConfig(config: LlmConfig): FormState {
  return {
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey: '',
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    temperature: numToInput(config.temperature),
    maxTokens: numToInput(config.maxTokens),
    contextWindow: numToInput(config.contextWindow),
    systemPromptExtra: config.systemPromptExtra ?? '',
    timeoutSeconds: numToInput(config.timeoutSeconds),
    maxRetries: numToInput(config.maxRetries),
    requestsPerMinute: numToInput(config.requestsPerMinute),
    maxTokensPerRun: numToInput(config.maxTokensPerRun),
    customHeaders: config.customHeaders ? JSON.stringify(config.customHeaders, null, 2) : '',
    isDefault: config.isDefault,
    enabled: config.enabled,
  };
}

type BuildResult = { payload: LlmConfigPayload } | { error: string };

function applyNumericFields(form: FormState, payload: LlmConfigPayload): string | null {
  for (const field of NUMERIC_FIELDS) {
    const raw = form[field].trim();
    if (raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) return `"${field}" must be a number.`;
    payload[field] = value;
  }
  return null;
}

function parseCustomHeaders(raw: string): { headers: Record<string, string> } | { error: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: 'Custom headers must be valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Custom headers must be a JSON object of key/value pairs.' };
  }
  return { headers: parsed as Record<string, string> };
}

/** Build the API payload from the form, or return a validation error message. */
export function buildPayload(form: FormState): BuildResult {
  const payload: LlmConfigPayload = {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    thinkingLevel: form.thinkingLevel,
    isDefault: form.isDefault,
    enabled: form.enabled,
  };
  if (!payload.name || !payload.baseUrl || !payload.model) {
    return { error: 'Name, base URL and model are required.' };
  }
  if (form.apiKey) payload.apiKey = form.apiKey;
  const numericError = applyNumericFields(form, payload);
  if (numericError) return { error: numericError };
  const systemPromptExtra = form.systemPromptExtra.trim();
  if (systemPromptExtra) payload.systemPromptExtra = systemPromptExtra;
  const headers = parseCustomHeaders(form.customHeaders);
  if (headers && 'error' in headers) return { error: headers.error };
  if (headers) payload.customHeaders = headers.headers;
  return { payload };
}
