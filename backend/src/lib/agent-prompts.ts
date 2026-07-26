import type { Repository, Task } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config.js';
import {
  llmCall,
  TokenBudgetExceededError,
  type LlmRuntime,
} from './agent-runtime.js';
import { extractJsonArray, parseLlmJson } from './llm-json.js';
import type { ChatMessage } from './llm-client.js';
import { truncateKeyFile } from './repo-context.js';
import { imageContentPart, parseTaskAttachments } from './task-attachments.js';
import { errorMessage } from './utils.js';

// Prompt builders, response schemas, and slug/message helpers for the agent
// loop's LLM calls. Extracted from agent-loop.ts; the pure builders are
// unit-tested in tests/agent-prompts.test.ts.

// ---------------------------------------------------------------------------
// Change-set requests (run-task + review-fix share this contract)
// ---------------------------------------------------------------------------

const llmChangeSchema = z.object({
  path: z.string().min(1).max(500),
  action: z.enum(['create', 'modify', 'delete']),
  content: z.string().optional(),
});
const llmChangesResponseSchema = z.object({
  summary: z.string().min(1).max(4_000),
  changes: z.array(llmChangeSchema).max(100),
});
export type LlmChangesResponse = z.infer<typeof llmChangesResponseSchema>;
export type LlmChange = LlmChangesResponse['changes'][number];

// ---------------------------------------------------------------------------
// Active skills (Repository.skillSlugs → Task.skills → system prompt)
// ---------------------------------------------------------------------------

// Hard cap on injected skill content so context budgets hold regardless of
// how many/large the selected skills are.
export const MAX_SKILLS_SECTION_CHARS = 20_000;

export interface PromptSkill {
  name: string;
  slug: string;
  content: string;
}

// System-prompt section for the task's skills: one `### name (slug)` block
// per skill, capped at MAX_SKILLS_SECTION_CHARS of content overall — an
// oversized skill is truncated with a marker and later skills are dropped.
export function buildSkillsSection(skills: PromptSkill[]): string {
  if (skills.length === 0) return '';
  const parts: string[] = [];
  let remaining = MAX_SKILLS_SECTION_CHARS;
  for (const skill of skills) {
    if (remaining <= 0) break;
    const content = truncateKeyFile(skill.content, remaining);
    parts.push(`### ${skill.name} (${skill.slug})\n${content}`);
    remaining -= content.length;
  }
  return ['## Active skills', ...parts].join('\n\n');
}

export function agentSystemPrompt(
  systemPromptExtra: string | null,
  skillsSection = '',
): string {
  return [
    'You are Lemniscate, an autonomous coding agent working inside a git repository.',
    'You are given the repository file tree, the contents of its key files, and a task.',
    'Respond with STRICT JSON only — no markdown fences, no commentary — matching exactly:',
    '{"summary": string, "changes": [{"path": string, "action": "create"|"modify"|"delete", "content"?: string}]}',
    'Rules:',
    '- For "create" and "modify", "content" MUST hold the COMPLETE new file content.',
    '- For "delete", omit "content".',
    '- Keep changes minimal and focused on the task; do not reformat unrelated code.',
    '- Paths are relative to the repository root.',
    '- Never include secrets, tokens, or credentials.',
    ...(systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', systemPromptExtra]
      : []),
    ...(skillsSection ? ['', skillsSection] : []),
  ].join('\n');
}

export function changesUserContent(task: Task, repoContext: string): string {
  return [
    `# Task\n${task.title}`,
    task.prompt ? `\n${task.prompt}` : '',
    `\n# Repository context\n${repoContext}`,
  ].join('\n');
}

// Main change-request message: plain text, or OpenAI multimodal content
// parts (text + image_url) when the task carries image attachments.
export function changesUserMessage(task: Task, repoContext: string): ChatMessage {
  const text = changesUserContent(task, repoContext);
  const attachments = parseTaskAttachments(task.attachments);
  if (attachments.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [{ type: 'text', text }, ...attachments.map(imageContentPart)],
  };
}

// One-shot self-repair: the failed response plus why it was rejected.
function repairUserPrompt(err: unknown): string {
  return [
    'Your previous response could not be used:',
    errorMessage(err),
    'Return ONLY the JSON object, no prose.',
  ].join('\n');
}

export async function requestChanges(
  rt: LlmRuntime,
  task: Task,
  repoContext: string,
  userContentOverride?: string,
  skillsSection = '',
): Promise<LlmChangesResponse> {
  const userMessage: ChatMessage =
    userContentOverride !== undefined
      ? { role: 'user', content: userContentOverride }
      : changesUserMessage(task, repoContext);
  const messages: ChatMessage[] = [
    { role: 'system', content: agentSystemPrompt(rt.cfg.systemPromptExtra, skillsSection) },
    userMessage,
  ];
  const content = await llmCall(rt, messages);
  try {
    return parseLlmJson(llmChangesResponseSchema, content, 'an invalid change set');
  } catch (err) {
    const repair: ChatMessage[] = [
      { role: 'assistant', content },
      { role: 'user', content: repairUserPrompt(err) },
    ];
    const repaired = await llmCall(rt, [...messages, ...repair]);
    return parseLlmJson(llmChangesResponseSchema, repaired, 'an invalid change set');
  }
}

// ---------------------------------------------------------------------------
// Branch names + commit messages
// ---------------------------------------------------------------------------

export function slugify(text: string, maxLength: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

// Branch name: LLM-proposed slug, sanitized, prefix + slug ≤ 40 chars.
export function maxBranchSlugLength(prefix: string): number {
  return Math.max(8, 40 - prefix.length);
}

export function fallbackBranchSlug(taskId: string, maxSlugLength: number): string {
  return slugify(`task-${taskId.slice(0, 8)}`, maxSlugLength);
}

function branchSlugUserPrompt(maxSlugLength: number, task: Task): string {
  return [
    `Propose a short kebab-case git branch slug (max ${maxSlugLength} characters) for this task.`,
    'Reply with ONLY the slug, nothing else.',
    '',
    `Title: ${task.title}`,
    task.prompt ?? '',
  ].join('\n');
}

export async function generateBranchName(rt: LlmRuntime, task: Task): Promise<string> {
  const prefix = config.AGENT_BRANCH_PREFIX;
  const maxSlugLength = maxBranchSlugLength(prefix);
  const fallback = fallbackBranchSlug(task.id, maxSlugLength);
  try {
    const content = await llmCall(rt, [
      { role: 'user', content: branchSlugUserPrompt(maxSlugLength, task) },
    ]);
    return `${prefix}${slugify(content, maxSlugLength) || fallback}`;
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) throw err;
    return `${prefix}${fallback}`;
  }
}

const COMMIT_MESSAGE_FALLBACK = 'chore: apply lemniscate agent changes';

function commitMessageUserPrompt(task: Task, summary: string): string {
  return [
    'Write a concise conventional-commit message (single line, max 72 characters) for these changes.',
    'Reply with ONLY the commit message, nothing else.',
    '',
    `Task: ${task.title}`,
    `Summary: ${summary}`,
  ].join('\n');
}

export function commitMessageFromResponse(content: string, fallback: string): string {
  const firstLine =
    content
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const cleaned = firstLine.replace(/^["'`]+|["'`]+$/g, '').slice(0, 72).trim();
  return cleaned || fallback;
}

export async function generateCommitMessage(
  rt: LlmRuntime,
  task: Task,
  summary: string,
): Promise<string> {
  try {
    const content = await llmCall(rt, [
      { role: 'user', content: commitMessageUserPrompt(task, summary) },
    ]);
    return commitMessageFromResponse(content, COMMIT_MESSAGE_FALLBACK);
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) throw err;
    return COMMIT_MESSAGE_FALLBACK;
  }
}

export function buildPrBody(task: Task, summary: string): string {
  return [
    '## Task',
    '',
    task.prompt?.trim() || task.title,
    '',
    '## Summary of changes',
    '',
    summary,
    '',
    '---',
    '_Generated by the Lemniscate agent_',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Proposal requests ('generate-proposals' jobs)
// ---------------------------------------------------------------------------

/** Canonical category labels for generated proposals (shown as badges in the UI). */
export const PROPOSAL_CATEGORIES = [
  'ux/ui',
  'security',
  'bug fix',
  'performance',
  'a11y',
  'scalability',
  'code quality',
  'testing',
  'documentation',
  'devops',
  'monitoring',
  'data quality',
  'compliance',
  'i18n',
  'cost',
  'seo',
  'api design',
  'mobile',
  'error handling',
  'onboarding',
] as const;

export type ProposalCategory = (typeof PROPOSAL_CATEGORIES)[number];

const DEFAULT_PROPOSAL_CATEGORY: ProposalCategory = 'code quality';

/** Priority levels for generated proposals, highest first. */
export const PROPOSAL_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type ProposalPriority = (typeof PROPOSAL_PRIORITIES)[number];

/** Effort sizes: small ≈ hours, medium ≈ days, large ≈ weeks. */
export const PROPOSAL_EFFORTS = ['small', 'medium', 'large'] as const;
export type ProposalEffort = (typeof PROPOSAL_EFFORTS)[number];

const llmProposalSchema = z.object({
  title: z.string().min(1).max(200),
  // The full structured proposal document — longer than a plain instruction.
  prompt: z.string().min(1).max(16_000),
  // Unknown/missing fields fall back instead of rejecting the proposal.
  category: z.enum(PROPOSAL_CATEGORIES).catch(DEFAULT_PROPOSAL_CATEGORY),
  priority: z.enum(PROPOSAL_PRIORITIES).catch('medium'),
  effort: z.enum(PROPOSAL_EFFORTS).catch('medium'),
});
// Single home for the proposals contract: requestProposals (direct LLM) and
// the hermes proposals-file parsing in agent-proposals.ts both validate
// against this schema.
export const llmProposalsSchema = z.array(llmProposalSchema).max(5);
export type LlmProposals = z.infer<typeof llmProposalsSchema>;

/** Structured sections of the proposal task document — the single home for
 *  the shape shared by proposal generation and the task Improve button. */
export function proposalDocumentSectionLines(): string[] {
  return [
    '## 1. Non-Technical Summary — Problem, Why it matters, Risk of not addressing it, Expected benefit (quantify if possible).',
    '## 2. Technical Details — Root cause/current state (reference specific files and functions), Proposed solution, Tech stack/tools required, numbered Implementation steps, Dependencies, Risks/trade-offs, Testing strategy.',
    '## 3. Success Metrics — how we will know the improvement worked.',
  ];
}

/** Shared JSON contract lines used by both proposal generation prompts. */
export function proposalJsonContractLines(): string[] {
  return [
    '[{"title": string, "category": string, "priority": "critical"|"high"|"medium"|"low", "effort": "small"|"medium"|"large", "prompt": string}]',
    '"title" is a short imperative summary; "category" is exactly one of the categories above; "effort" is small (hours), medium (days), or large (weeks).',
    '"prompt" is the full structured proposal document in markdown, with exactly these sections:',
    ...proposalDocumentSectionLines(),
    'Ground every claim in what you actually observe in the code — no generic advice. End the document with a one-line directive the implementing coding agent can execute directly.',
  ];
}

export function proposalsSystemPrompt(systemPromptExtra: string | null): string {
  return [
    'You are a senior software architect and product consultant reviewing a codebase.',
    'You are given a repository file tree and its key files.',
    'Analyze the code and propose up to 5 concrete, URGENT improvements this repository genuinely needs — do not pad with filler or cosmetic tweaks.',
    `Categorize each proposal under exactly one of: ${PROPOSAL_CATEGORIES.join(', ')}.`,
    'Cover DIFFERENT categories across the proposals.',
    'Order the proposals by priority, critical first.',
    'Respond with STRICT JSON only — no markdown fences, no commentary — a JSON array matching:',
    ...proposalJsonContractLines(),
    ...(systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', systemPromptExtra]
      : []),
  ].join('\n');
}

export async function requestProposals(
  rt: LlmRuntime,
  repository: Repository,
  repoContext: string,
): Promise<LlmProposals> {
  const content = await llmCall(rt, [
    { role: 'system', content: proposalsSystemPrompt(rt.cfg.systemPromptExtra) },
    {
      role: 'user',
      content: `# Repository\n${repository.fullName}\n\n# Repository context\n${repoContext}`,
    },
  ]);
  const parsed = llmProposalsSchema.safeParse(extractJsonArray(content));
  if (!parsed.success) {
    throw new Error(
      `LLM returned invalid proposals: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  return parsed.data;
}
