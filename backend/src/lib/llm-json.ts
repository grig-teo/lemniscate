import { z } from 'zod';

// Strict-JSON extraction for LLM responses. Single home for logic that was
// duplicated verbatim between agent-loop.ts and pr-review.ts. Kept free of
// config/prisma/redis imports so it stays unit-testable without any env.

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('LLM response did not contain a JSON object');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('LLM response contained malformed JSON');
  }
}

export function extractJsonArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new Error('LLM response did not contain a JSON array');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('LLM response contained malformed JSON');
  }
}

// Extracts the first JSON object from an LLM response and validates it.
// `label` completes the error message: `LLM returned <label>: <issue>`.
export function parseLlmJson<S extends z.ZodTypeAny>(
  schema: S,
  text: string,
  label: string,
): z.infer<S> {
  const parsed = schema.safeParse(extractJsonObject(text));
  if (!parsed.success) {
    throw new Error(
      `LLM returned ${label}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  return parsed.data;
}
