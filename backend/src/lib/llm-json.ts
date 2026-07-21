import { z } from 'zod';

// Strict-JSON extraction for LLM responses. Single home for logic that was
// duplicated verbatim between agent-loop.ts and pr-review.ts. Kept free of
// config/prisma/redis imports so it stays unit-testable without any env.

const SNIPPET_MAX_CHARS = 300;

// Whitespace-collapsed head of the raw response, for diagnosable errors.
function rawSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX_CHARS);
}

function snippetSuffix(text: string): string {
  return ` Raw response (first ${SNIPPET_MAX_CHARS} chars, whitespace-collapsed): "${rawSnippet(text)}"`;
}

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`LLM response did not contain a JSON object.${snippetSuffix(text)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error(`LLM response contained malformed JSON.${snippetSuffix(text)}`);
  }
}

export function extractJsonArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new Error(`LLM response did not contain a JSON array.${snippetSuffix(text)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error(`LLM response contained malformed JSON.${snippetSuffix(text)}`);
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
