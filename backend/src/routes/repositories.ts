import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const patchBodySchema = z
  .object({
    autoPropose: z.boolean().optional(),
    autoCreatePr: z.boolean().optional(),
    autoReviewPr: z.boolean().optional(),
    autoMergePr: z.boolean().optional(),
    // null explicitly detaches the LLM config.
    llmConfigId: z.string().min(1).nullable().optional(),
  })
  .strict();

type PatchBody = z.infer<typeof patchBodySchema>;

// Only the fields that were actually sent are written.
function buildPatchData(data: PatchBody) {
  return {
    ...(data.autoPropose !== undefined ? { autoPropose: data.autoPropose } : {}),
    ...(data.autoCreatePr !== undefined ? { autoCreatePr: data.autoCreatePr } : {}),
    ...(data.autoReviewPr !== undefined ? { autoReviewPr: data.autoReviewPr } : {}),
    ...(data.autoMergePr !== undefined ? { autoMergePr: data.autoMergePr } : {}),
    ...(data.llmConfigId !== undefined ? { llmConfigId: data.llmConfigId } : {}),
  };
}

// Auto-merge only makes sense on top of an LLM review: merging without a
// review would bypass human oversight entirely.
function autoMergeViolation(
  data: PatchBody,
  current: { autoReviewPr: boolean },
): boolean {
  const effectiveAutoReview = data.autoReviewPr ?? current.autoReviewPr;
  return data.autoMergePr === true && !effectiveAutoReview;
}

async function ownedLlmConfigExists(userId: string, llmConfigId: string): Promise<boolean> {
  const llmConfig = await prisma.llmConfig.findFirst({
    where: { id: llmConfigId, userId },
    select: { id: true },
  });
  return llmConfig !== null;
}

// Keeps the worker's repeatable 'generate-proposals' job in sync with the
// autoPropose flag. Scheduling failure must not fail the PATCH — log it.
async function syncProposalSchedule(
  request: FastifyRequest,
  repositoryId: string,
  autoPropose: boolean | undefined,
  previous: boolean,
): Promise<void> {
  if (autoPropose === undefined || autoPropose === previous) return;
  try {
    const scheduler = await import('../lib/proposal-scheduler.js');
    if (autoPropose) {
      await scheduler.scheduleProposals(repositoryId);
    } else {
      await scheduler.unscheduleProposals(repositoryId);
    }
  } catch (err) {
    request.log.error({ err }, 'failed to update proposal schedule');
  }
}

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
      select: { id: true, autoPropose: true, autoReviewPr: true },
    });
    if (!repository) {
      return reply.code(404).send({ error: 'Repository not found' });
    }
    if (autoMergeViolation(data, repository)) {
      return reply.code(400).send({ error: 'autoMergePr requires autoReviewPr to be enabled' });
    }
    if (data.llmConfigId && !(await ownedLlmConfigExists(userId, data.llmConfigId))) {
      return reply.code(400).send({ error: 'llmConfigId does not reference your LLM config' });
    }

    const updated = await prisma.repository.update({
      where: { id: repository.id },
      data: buildPatchData(data),
      include: {
        connection: { select: { provider: true, username: true } },
      },
    });
    await syncProposalSchedule(request, repository.id, data.autoPropose, repository.autoPropose);
    return { repository: updated };
  });
};

export default repositoriesRoutes;
