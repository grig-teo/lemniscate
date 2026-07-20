import path from 'node:path';
import type { GitConnection, Repository } from '@prisma/client';
import { config } from '../config.js';
import { cleanupWorkdir, cloneRepository } from './agent-git.js';
import { requestProposals, type LlmProposals } from './agent-prompts.js';
import { prepareAgentRuntime } from './agent-runtime.js';
import { prisma } from './prisma.js';
import { enqueueRunTask } from './proposal-scheduler.js';
import { buildRepoContext } from './repo-context.js';

// Job: generate-proposals — the LLM suggests up to 5 improvement tasks for a
// repository, each enqueued as its own run-task job. Extracted from
// agent-loop.ts.

type RepositoryWithConnection = Repository & { connection: GitConnection };

// Titles of proposals already pending/queued for this repo (normalized), so
// re-runs do not pile up duplicates.
async function loadPendingProposalTitles(repositoryId: string): Promise<Set<string>> {
  const existing = await prisma.task.findMany({
    where: {
      repositoryId,
      kind: 'proposal',
      status: { in: ['pending', 'queued'] },
    },
    select: { title: true },
  });
  return new Set(existing.map((t) => t.title.trim().toLowerCase()));
}

async function createProposalTasks(
  repository: RepositoryWithConnection,
  proposals: LlmProposals,
): Promise<number> {
  const seenTitles = await loadPendingProposalTitles(repository.id);
  let created = 0;
  for (const proposal of proposals.slice(0, 5)) {
    const key = proposal.title.trim().toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    const task = await prisma.task.create({
      data: {
        repositoryId: repository.id,
        kind: 'proposal',
        title: proposal.title,
        prompt: proposal.prompt,
        status: 'queued',
        ...(repository.llmConfigId ? { llmConfigId: repository.llmConfigId } : {}),
      },
    });
    await enqueueRunTask(task.id);
    created += 1;
  }
  return created;
}

async function executeGenerateProposals(
  repository: RepositoryWithConnection,
  workdir: string,
  secrets: string[],
): Promise<void> {
  const { cloneUrl, rt } = await prepareAgentRuntime(null, repository, secrets);
  await cloneRepository(workdir, cloneUrl, repository.defaultBranch, secrets);
  const repoContext = await buildRepoContext(workdir, rt.cfg.contextWindow);
  const proposals = await requestProposals(rt, repository, repoContext);
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
  if (!repository.autoPropose) {
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
