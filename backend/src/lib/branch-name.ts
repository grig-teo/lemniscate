import { llmCall, type LlmRuntime } from './agent-runtime.js';

// Branch-name generation: one cheap LLM call producing a short kebab-case
// slug for the task branch. Extracted from agent-prompts.ts when the
// internal propose/apply executor was removed — everything else there was
// internal-only.

const BRANCH_NAME_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string', maxLength: 60 },
  },
  required: ['branch'],
  additionalProperties: false,
} as const;

// Derives a short, URL-safe branch name for the task via one cheap LLM
// call. The caller appends a suffix for uniqueness.
export async function generateBranchName(rt: LlmRuntime, title: string): Promise<string> {
  const fallback = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  try {
    const text = await llmCall(rt, [
      {
        role: 'system',
        content:
          'Generate a short git branch name (2-5 words, kebab-case, lowercase, no prefix like feat/ or fix/) for the given task. Respond with STRICT JSON: {"branch": "..."}.',
      },
      { role: 'user', content: title },
    ], BRANCH_NAME_SCHEMA as object);
    const parsed = JSON.parse(text) as { branch?: string };
    const branch = (parsed.branch ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '');
    return branch || fallback;
  } catch {
    return fallback;
  }
}
