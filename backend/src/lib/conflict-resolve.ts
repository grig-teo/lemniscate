import { z } from 'zod';
import { parseLlmJson } from './llm-json.js';
import type { ChatMessage } from './llm-client.js';
import { PROMPT_INJECTION_GUARD, SECRETS_HANDLING_GUARD } from './prompt-guards.js';

// Merge-conflict resolution via direct LLM call: the response contract
// (resolved content OR an explicit unresolved bail-out), its parser, and the
// prompt builder. Extracted from pr-review.ts to keep both modules under the
// 300-line guard (AGENTS.md §2); pure, so it stays unit-testable without any
// environment. The hermes/lemcore conflict prompt stays in pr-review.ts.

// The conflict-resolution answer: either the complete resolved file content,
// or an explicit "unresolved" bail-out when the two sides are semantically
// incompatible and a human must decide.
export const resolvedFileSchema = z.object({
  content: z.string().nullable(),
  unresolved: z.boolean().optional(),
  reason: z.string().max(2_000).optional(),
});

export type ResolvedFileResult =
  | { status: 'resolved'; content: string }
  | { status: 'unresolved'; reason: string };

const DEFAULT_UNRESOLVED_REASON =
  'the two sides make incompatible changes to the same logic';

export function parseResolvedFile(text: string): ResolvedFileResult {
  const parsed = parseLlmJson(resolvedFileSchema, text, 'an invalid resolved file');
  if (parsed.unresolved === true || parsed.content === null) {
    return {
      status: 'unresolved',
      reason: parsed.reason?.trim() || DEFAULT_UNRESOLVED_REASON,
    };
  }
  if (hasConflictMarkers(parsed.content)) {
    throw new Error('LLM returned a resolved file that still contains conflict markers');
  }
  return { status: 'resolved', content: parsed.content };
}

// Defensive check that an LLM-resolved file has no leftover merge markers.
export function hasConflictMarkers(content: string): boolean {
  return content
    .split('\n')
    .some(
      (line) =>
        line.startsWith('<<<<<<<') || line.startsWith('>>>>>>>') || line.startsWith('======='),
    );
}

export function buildConflictResolutionMessages(input: {
  path: string;
  conflictedContent: string;
  baseBranch: string;
  headBranch: string;
  systemPromptExtra?: string | null;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are Lemniscate, an autonomous coding agent resolving a git merge conflict.',
        'You are given one file containing conflict markers (<<<<<<< / ======= / >>>>>>>).',
        `The conflict comes from merging ${input.headBranch} into ${input.baseBranch}.`,
        PROMPT_INJECTION_GUARD,
        'Respond with STRICT JSON only — no markdown fences, no commentary — matching exactly:',
        '{"content": string}',
        '"content" MUST hold the COMPLETE resolved file with ALL conflict markers removed,',
        'combining both sides so the change from the pull request is preserved.',
        'If the two sides of the conflict make incompatible changes to the same logic',
        '(not just overlapping text — e.g. one side removes a function the other side',
        'calls), do not force a silent merge. Instead respond with:',
        '{"content": null, "unresolved": true, "reason": string} explaining the conflict',
        'so a human can resolve it.',
        SECRETS_HANDLING_GUARD,
        ...(input.systemPromptExtra
          ? ['', 'Additional instructions from the repository owner:', input.systemPromptExtra]
          : []),
      ].join('\n'),
    },
    {
      role: 'user',
      content: `# File: ${input.path}\n\`\`\`\n${input.conflictedContent}\n\`\`\``,
    },
  ];
}
