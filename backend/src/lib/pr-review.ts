import { z } from 'zod';
import { extractJsonObject, parseLlmJson } from './llm-json.js';
import type { ChatMessage } from './llm-client.js';

// Pure logic for the LLM PR-review flow: strict response parsing and prompt
// builders. Kept free of config/prisma/redis imports so it stays unit-testable
// without any environment.

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const prReviewIssueSchema = z.object({
  path: z.string().min(1).max(500).optional(),
  comment: z.string().min(1).max(4_000),
});

export const prReviewSchema = z.object({
  verdict: z.enum(['approve', 'changes_requested']),
  summary: z.string().min(1).max(4_000),
  issues: z.array(prReviewIssueSchema).max(50),
});

export type PrReview = z.infer<typeof prReviewSchema>;
export type PrReviewIssue = z.infer<typeof prReviewIssueSchema>;

export function parsePrReview(text: string): PrReview {
  return parseLlmJson(prReviewSchema, text, 'an invalid review');
}

// The conflict-resolution answer: the complete resolved file content.
export const resolvedFileSchema = z.object({
  content: z.string(),
});

export function parseResolvedFile(text: string): string {
  const content = parseLlmJson(resolvedFileSchema, text, 'an invalid resolved file').content;
  if (hasConflictMarkers(content)) {
    throw new Error('LLM returned a resolved file that still contains conflict markers');
  }
  return content;
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

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildReviewMessages(input: {
  taskTitle: string;
  taskPrompt: string | null;
  diff: string;
  systemPromptExtra?: string | null;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are Lemniscate, an autonomous code reviewer.',
        'You are given a task description and the unified diff of a pull request implementing it.',
        'Decide whether the pull request correctly and safely implements the task.',
        'Respond with STRICT JSON only — no markdown fences, no commentary — matching exactly:',
        '{"verdict": "approve"|"changes_requested", "summary": string, "issues": [{"path"?: string, "comment": string}]}',
        'Rules:',
        '- "approve" only when the change is correct, minimal, and safe to merge.',
        '- List concrete, actionable issues; do not request stylistic-only rewrites.',
        '- Use "issues": [] when approving.',
        ...(input.systemPromptExtra
          ? ['', 'Additional instructions from the repository owner:', input.systemPromptExtra]
          : []),
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `# Task\n${input.taskTitle}`,
        input.taskPrompt ? `\n${input.taskPrompt}` : '',
        `\n# Pull request diff\n\`\`\`diff\n${input.diff}\n\`\`\``,
      ].join('\n'),
    },
  ];
}

export function buildFixUserPrompt(input: {
  taskTitle: string;
  taskPrompt: string | null;
  review: PrReview;
}): string {
  const issues = input.review.issues
    .map((issue, index) => `${index + 1}. ${issue.path ? `\`${issue.path}\`: ` : ''}${issue.comment}`)
    .join('\n');
  return [
    `# Original task\n${input.taskTitle}`,
    input.taskPrompt ? `\n${input.taskPrompt}` : '',
    '\n# Code review feedback\nA reviewer requested changes on your pull request. Address every issue below with minimal, focused edits.',
    '',
    `Review summary: ${input.review.summary}`,
    '',
    issues || '(no specific issues listed)',
  ].join('\n');
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
        'Respond with STRICT JSON only — no markdown fences, no commentary — matching exactly:',
        '{"content": string}',
        '"content" MUST hold the COMPLETE resolved file with ALL conflict markers removed,',
        'combining both sides so the change from the pull request is preserved.',
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
