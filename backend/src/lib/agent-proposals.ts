import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GitConnection, Repository, Skill } from '@prisma/client';
import { config } from '../config.js';
import { cleanupWorkdir, cloneRepository } from './agent-git.js';
import {
  buildSkillsSection,
  llmProposalsSchema,
  requestProposals,
  type LlmProposals,
} from './agent-prompts.js';
import { prepareAgentRuntime, type LlmRuntime } from './agent-runtime.js';
import { runHermesTask, type HermesLlmConfig } from './hermes-runner.js';
import { extractJsonArray } from './llm-json.js';
import { prisma } from './prisma.js';
import { buildRepoContext } from './repo-context.js';
import { loadAgentsMdTemplate, parseSkillSlugs } from './task-skills.js';

// Job: generate-proposals — the LLM suggests up to 5 improvement tasks for a
// repository. They are created as pending proposal tasks (click-to-run: the
// user starts each via POST /tasks/:id/start), deduped by title against
// pending/queued ones and topped up to at most MAX_PENDING_PROPOSALS pending.
// Extracted from agent-loop.ts.

type RepositoryWithConnection = Repository & { connection: GitConnection };

export const MAX_PENDING_PROPOSALS = 5;

// Hermes executor: the agent explores the clone itself and writes its
// proposals to this file instead of answering a single LLM request.
const PROPOSALS_FILENAME = '.lemniscate-proposals.json';

// ---------------------------------------------------------------------------
// Hermes executor (pure helpers, unit-tested in tests/agent-proposals.test.ts)
// ---------------------------------------------------------------------------

export interface HermesProposalPromptOptions {
  maxProposals: number;
  skillsSection: string;
  systemPromptExtra: string | null;
}

// Prompt for the hermes proposals run: explore the freshly cloned repo and
// write the proposals file — no implementing, no git mutations.
export function buildHermesProposalPrompt(opts: HermesProposalPromptOptions): string {
  return [
    'You are Lemniscate, an autonomous code-review agent.',
    `Explore the current directory (a freshly cloned repository) and propose up to ${opts.maxProposals} concrete, high-value improvement or bug-fix tasks.`,
    `Write them to ${PROPOSALS_FILENAME} in the repository root as STRICT JSON:`,
    '[{"title": string, "prompt": string}]',
    '"title" is a short imperative summary; "prompt" is a detailed instruction another coding agent can execute directly.',
    `Do NOT implement the proposals. Do NOT git commit, push, or create branches — your only output is ${PROPOSALS_FILENAME}.`,
    "The repository's AGENTS.md context (its conventions and instructions) applies to what you propose.",
    ...(opts.systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', opts.systemPromptExtra]
      : []),
    ...(opts.skillsSection ? ['', opts.skillsSection] : []),
  ].join('\n');
}

// Validates the hermes-written proposals file against the same schema as the
// direct LLM path. Tolerates markdown fences / surrounding prose; anything
// unusable yields null so the caller can fall back to requestProposals.
export function parseProposalsFile(raw: string): LlmProposals | null {
  try {
    const parsed = llmProposalsSchema.safeParse(extractJsonArray(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type PendingProposalState = { titles: Set<string>; pendingCount: number };

// Pure core of loadPendingProposalState: dedupe titles come from ALL
// pending/queued proposals (archived ones included — don't re-propose what
// the user archived), but only non-archived pendings count toward the
// top-up cap.
export function pendingProposalState(
  rows: Array<{ title: string; status: string; archivedAt?: Date | null }>,
): PendingProposalState {
  const titles = new Set(rows.map((t) => t.title.trim().toLowerCase()));
  const pendingCount = rows.filter((t) => t.status === 'pending' && !t.archivedAt).length;
  return { titles, pendingCount };
}

// Titles of proposals already pending/queued for this repo (normalized), so
// re-runs do not pile up duplicates, plus the pending count for the top-up cap.
async function loadPendingProposalState(repositoryId: string): Promise<PendingProposalState> {
  const existing = await prisma.task.findMany({
    where: {
      repositoryId,
      kind: 'proposal',
      status: { in: ['pending', 'queued'] },
    },
    select: { title: true, status: true, archivedAt: true },
  });
  return pendingProposalState(existing);
}

function proposalTaskData(repository: RepositoryWithConnection, proposal: LlmProposals[number]) {
  return {
    repositoryId: repository.id,
    kind: 'proposal' as const,
    title: proposal.title,
    prompt: proposal.prompt,
    status: 'pending' as const,
    // Proposals inherit the repository's skills, same as prompt tasks.
    skills: parseSkillSlugs(repository.skillSlugs),
    ...(repository.llmConfigId ? { llmConfigId: repository.llmConfigId } : {}),
  };
}

// Creates new pending proposal tasks, at most enough to bring the repo back
// to MAX_PENDING_PROPOSALS pending. Nothing is enqueued — proposals wait for
// user approval.
async function createProposalTasks(
  repository: RepositoryWithConnection,
  proposals: LlmProposals,
): Promise<number> {
  const { titles, pendingCount } = await loadPendingProposalState(repository.id);
  const budget = MAX_PENDING_PROPOSALS - pendingCount;
  let created = 0;
  for (const proposal of proposals.slice(0, MAX_PENDING_PROPOSALS)) {
    if (created >= budget) break;
    const key = proposal.title.trim().toLowerCase();
    if (titles.has(key)) continue;
    titles.add(key);
    await prisma.task.create({ data: proposalTaskData(repository, proposal) });
    created += 1;
  }
  return created;
}

// Same order-preserving slug resolution as loadTaskSkills, minus the task
// console (the proposals job has none).
async function loadRepositorySkills(repository: RepositoryWithConnection): Promise<Skill[]> {
  const slugs = parseSkillSlugs(repository.skillSlugs);
  if (slugs.length === 0) return [];
  const rows = await prisma.skill.findMany({ where: { slug: { in: slugs } } });
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  return slugs.flatMap((slug) => bySlug.get(slug) ?? []);
}

function hermesLlmConfig(rt: LlmRuntime): HermesLlmConfig {
  return {
    baseUrl: rt.cfg.baseUrl,
    apiKey: rt.apiKey,
    model: rt.cfg.model,
    contextWindow: rt.cfg.contextWindow,
  };
}

async function readHermesProposalsFile(workdir: string): Promise<LlmProposals | null> {
  const raw = await fs.readFile(path.join(workdir, PROPOSALS_FILENAME), 'utf8').catch(() => null);
  if (raw === null) return null;
  return parseProposalsFile(raw);
}

// Hermes run without a taskId: no task console, no cancel poll — the job's
// only feedback is the returned proposals (or the fallback below).
async function requestProposalsViaHermes(
  repository: RepositoryWithConnection,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
): Promise<LlmProposals | null> {
  const skills = await loadRepositorySkills(repository);
  await runHermesTask({
    workdir,
    prompt: buildHermesProposalPrompt({
      maxProposals: MAX_PENDING_PROPOSALS,
      skillsSection: buildSkillsSection(skills),
      systemPromptExtra: rt.cfg.systemPromptExtra,
    }),
    llm: hermesLlmConfig(rt),
    secrets,
    timeoutMs: config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000,
  });
  return readHermesProposalsFile(workdir);
}

// Executor branch: 'hermes' lets the agent explore the clone and write the
// proposals file, falling back to the direct LLM request when the file is
// missing/invalid so the top-up still works; 'internal' is unchanged.
async function generateProposalList(
  repository: RepositoryWithConnection,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
  repoContext: string,
): Promise<LlmProposals> {
  if (config.AGENT_EXECUTOR !== 'hermes') return requestProposals(rt, repository, repoContext);
  const proposals = await requestProposalsViaHermes(repository, rt, workdir, secrets);
  if (proposals) return proposals;
  console.warn(
    `generate-proposals: ${repository.fullName}: no valid ${PROPOSALS_FILENAME} from hermes, falling back to direct LLM request`,
  );
  return requestProposals(rt, repository, repoContext);
}

async function executeGenerateProposals(
  repository: RepositoryWithConnection,
  workdir: string,
  secrets: string[],
): Promise<void> {
  const { cloneUrl, rt } = await prepareAgentRuntime(null, repository, secrets);
  // Empty remotes are bootstrapped by cloneRepository's init fallback, so an
  // empty repo simply yields greenfield proposals.
  await cloneRepository(workdir, cloneUrl, repository.defaultBranch, secrets);
  const agentsMdTemplate = await loadAgentsMdTemplate(repository);
  const { text: repoContext } = await buildRepoContext(
    workdir,
    rt.cfg.contextWindow,
    agentsMdTemplate,
  );
  const proposals = await generateProposalList(repository, rt, workdir, secrets, repoContext);
  const created = await createProposalTasks(repository, proposals);
  console.log(
    `generate-proposals: ${repository.fullName}: ${proposals.length} proposed, ${created} created`,
  );
}

export async function generateProposals(repositoryId: string): Promise<void> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: { connection: true },
  });
  if (!repository) {
    console.error(`generate-proposals: repository ${repositoryId} not found`);
    return;
  }
  // Triggered by the round-button endpoint and the global 'proposals-topup'
  // repeatable job. Bail out before cloning when the repo is already topped
  // up — the LLM call would only produce proposals that get created: 0.
  const { pendingCount } = await loadPendingProposalState(repositoryId);
  if (pendingCount >= MAX_PENDING_PROPOSALS) {
    console.log(
      `generate-proposals: ${repository.fullName}: ${MAX_PENDING_PROPOSALS} proposals already pending, skipping`,
    );
    return;
  }

  const secrets: string[] = [];
  const workdir = path.join(config.AGENT_WORKDIR, `proposals-${repositoryId}`);
  try {
    await executeGenerateProposals(repository, workdir, secrets);
  } finally {
    await cleanupWorkdir(workdir);
  }
}
