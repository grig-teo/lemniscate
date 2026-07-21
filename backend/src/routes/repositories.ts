import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { findUnknownSkillSlugs, isAgentsMdSkill } from '../lib/task-skills.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const patchBodySchema = z
  .object({
    autoCreatePr: z.boolean().optional(),
    autoReviewPr: z.boolean().optional(),
    autoMergePr: z.boolean().optional(),
    autoRunProposals: z.boolean().optional(),
    hidden: z.boolean().optional(),
    // null explicitly detaches the LLM config.
    llmConfigId: z.string().min(1).nullable().optional(),
    // Slugs of skills injected into the agent's system prompt for tasks on
    // this repository; existence validated against the Skill table below.
    skillSlugs: z.array(z.string().min(1)).max(20).optional(),
    // AGENTS.md template skill (kind 'agents_md') used when the cloned repo
    // root lacks one; null explicitly detaches it.
    agentsMdSkillId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const bulkFlagsSchema = z
  .object({
    autoCreatePr: z.boolean(),
    autoReviewPr: z.boolean(),
    autoMergePr: z.boolean(),
  })
  .strict();

type PatchBody = z.infer<typeof patchBodySchema>;
type BulkFlagsBody = z.infer<typeof bulkFlagsSchema>;

// Only the fields that were actually sent are written.
export function buildPatchData(data: PatchBody) {
  return {
    ...(data.autoCreatePr !== undefined ? { autoCreatePr: data.autoCreatePr } : {}),
    ...(data.autoReviewPr !== undefined ? { autoReviewPr: data.autoReviewPr } : {}),
    ...(data.autoMergePr !== undefined ? { autoMergePr: data.autoMergePr } : {}),
    ...(data.autoRunProposals !== undefined ? { autoRunProposals: data.autoRunProposals } : {}),
    ...(data.hidden !== undefined ? { hidden: data.hidden } : {}),
    ...(data.llmConfigId !== undefined ? { llmConfigId: data.llmConfigId } : {}),
    ...(data.skillSlugs !== undefined ? { skillSlugs: data.skillSlugs } : {}),
    ...(data.agentsMdSkillId !== undefined ? { agentsMdSkillId: data.agentsMdSkillId } : {}),
  };
}

// Bulk writes set every flag, so the update object is the body itself.
export function buildBulkFlagsUpdate(data: BulkFlagsBody) {
  return {
    autoCreatePr: data.autoCreatePr,
    autoReviewPr: data.autoReviewPr,
    autoMergePr: data.autoMergePr,
  };
}

// Auto-merge only makes sense on top of an LLM review: merging without a
// review would bypass human oversight entirely. `flags` carries the effective
// (post-update) values: the PATCH handler merges body over current state
// first, the bulk handler passes its all-required body directly.
export function autoMergeViolation(flags: {
  autoMergePr?: boolean;
  autoReviewPr: boolean;
}): boolean {
  return flags.autoMergePr === true && !flags.autoReviewPr;
}

// True when any queued generate-proposals job targets this repository —
// used by the proposals/status endpoint to flag in-flight generation.
export function isGeneratingProposals(
  jobs: Array<{ name: string; data?: unknown }>,
  repositoryId: string,
): boolean {
  return jobs.some((job) => {
    if (job.name !== 'generate-proposals') return false;
    const data = job.data as { repositoryId?: unknown } | undefined;
    return data?.repositoryId === repositoryId;
  });
}

async function ownedLlmConfigExists(userId: string, llmConfigId: string): Promise<boolean> {
  const llmConfig = await prisma.llmConfig.findFirst({
    where: { id: llmConfigId, userId },
    select: { id: true },
  });
  return llmConfig !== null;
}

// Slugs from the patch body that have no Skill row — used to 400 with the
// offending names instead of silently storing dead references. Lives in
// lib/task-skills.ts (single home, shared with the repo-creation route).

const repositoriesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/repositories', async (request) => {
    const userId = authenticatedUserId(request);
    const repositories = await prisma.repository.findMany({
      where: { connection: { userId } },
      include: {
        connection: { select: { provider: true, username: true } },
      },
      orderBy: { fullName: 'asc' },
    });
    return { repositories };
  });

  // Registered before '/repositories/:id' so Fastify matches the literal
  // 'flags' segment instead of capturing it as an :id.
  app.post('/repositories/flags', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const data = parseOrReply(bulkFlagsSchema, request.body, reply, 'Invalid body', {
      includeIssues: true,
    });
    if (data === null) return;
    if (autoMergeViolation(data)) {
      return reply.code(400).send({ error: 'autoMergePr requires autoReviewPr to be enabled' });
    }

    const result = await prisma.repository.updateMany({
      where: { connection: { userId } },
      data: buildBulkFlagsUpdate(data),
    });
    return { updated: result.count };
  });

  app.patch('/repositories/:id', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid repository id');
    if (params === null) return;
    const data = parseOrReply(patchBodySchema, request.body, reply, 'Invalid body', {
      includeIssues: true,
    });
    if (data === null) return;

    const repository = await prisma.repository.findFirst({
      where: { id: params.id, connection: { userId } },
      select: { id: true, autoReviewPr: true },
    });
    if (!repository) {
      return reply.code(404).send({ error: 'Repository not found' });
    }
    const effectiveFlags = {
      autoMergePr: data.autoMergePr,
      autoReviewPr: data.autoReviewPr ?? repository.autoReviewPr,
    };
    if (autoMergeViolation(effectiveFlags)) {
      return reply.code(400).send({ error: 'autoMergePr requires autoReviewPr to be enabled' });
    }
    if (data.llmConfigId && !(await ownedLlmConfigExists(userId, data.llmConfigId))) {
      return reply.code(400).send({ error: 'llmConfigId does not reference your LLM config' });
    }
    if (data.skillSlugs) {
      const unknown = await findUnknownSkillSlugs(data.skillSlugs);
      if (unknown.length > 0) {
        return reply.code(400).send({ error: `Unknown skill slug(s): ${unknown.join(', ')}` });
      }
    }
    if (data.agentsMdSkillId && !(await isAgentsMdSkill(data.agentsMdSkillId))) {
      return reply
        .code(400)
        .send({ error: 'agentsMdSkillId does not reference an AGENTS.md skill' });
    }

    const updated = await prisma.repository.update({
      where: { id: repository.id },
      data: buildPatchData(data),
      include: {
        connection: { select: { provider: true, username: true } },
      },
    });
    return { repository: updated };
  });

  // Round-button trigger: enqueue one proposal generation run for the repo.
  // The job itself tops pending proposals up to 5 and dedupes by title.
  app.post('/repositories/:id/proposals', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid repository id');
    if (params === null) return;

    const repository = await prisma.repository.findFirst({
      where: { id: params.id, connection: { userId } },
      select: { id: true },
    });
    if (!repository) {
      return reply.code(404).send({ error: 'Repository not found' });
    }
    try {
      const scheduler = await import('../lib/proposal-scheduler.js');
      await scheduler.enqueueGenerateProposalsNow(repository.id);
    } catch (err) {
      request.log.error({ err }, 'failed to enqueue proposal generation');
      return reply.code(502).send({ error: 'Failed to enqueue proposal generation' });
    }
    return reply.code(202).send({ enqueued: true });
  });

  // Poll endpoint: is a generate-proposals job for this repo in flight?
  app.get('/repositories/:id/proposals/status', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid repository id');
    if (params === null) return;

    const repository = await prisma.repository.findFirst({
      where: { id: params.id, connection: { userId } },
      select: { id: true },
    });
    if (!repository) {
      return reply.code(404).send({ error: 'Repository not found' });
    }
    try {
      const scheduler = await import('../lib/proposal-scheduler.js');
      const jobs = await scheduler.getAgentTasksQueue().getJobs(['active', 'waiting', 'delayed']);
      return { generating: isGeneratingProposals(jobs, repository.id) };
    } catch (err) {
      request.log.error({ err }, 'failed to read proposal generation status');
      return reply.code(502).send({ error: 'Failed to read proposal generation status' });
    }
  });
};

export default repositoriesRoutes;
