import { z } from 'zod';

// The proposals contract — the single home for the shape every proposal
// generator validates against (the lemcore proposals-file parsing in
// agent-proposals.ts and the task Improve button in task-improve.ts).
// Pure module: no config/prisma/redis imports so it stays unit-testable
// without any environment.

/** Canonical category labels for generated proposals (shown as badges in the UI). */
export const PROPOSAL_CATEGORIES = [
  'features',
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

/** Shared guidance for the `features` category — the single home for the
 *  rules used by the proposal generation prompt. Feature proposals extend
 *  the product: new implementations, not maintenance of what already
 *  exists. */
export function featuresProposalGuidanceLines(): string[] {
  return [
    '`features` proposals suggest NEW implementations: capabilities, modules, integrations, or user-facing functionality the repository does not have yet — not maintenance of what exists.',
    'Include at least one `features` proposal whenever a genuine opportunity exists. A features proposal must name the concrete area of the codebase it extends, state the user/business value it unlocks, and be implementable within this repository.',
  ];
}

/** Shared JSON contract lines used by the proposal generation prompt. */
export function proposalJsonContractLines(): string[] {
  return [
    '[{"title": string, "category": string, "priority": "critical"|"high"|"medium"|"low", "effort": "small"|"medium"|"large", "prompt": string}]',
    '"title" is a short imperative summary; "category" is exactly one of the categories above; "effort" is small (hours), medium (days), or large (weeks).',
    '"prompt" is the full structured proposal document in markdown, with exactly these sections:',
    ...proposalDocumentSectionLines(),
    'Ground every claim in what you actually observe in the code — no generic advice. End the document with a one-line directive the implementing coding agent can execute directly.',
  ];
}
