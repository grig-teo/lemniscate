import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GitConnection } from '@prisma/client';
import {
  getProviderClient,
  ProviderError,
  type NormalizedRepo,
} from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import { enqueueRunTask } from '../lib/proposal-scheduler.js';
import { buildRepoInitFiles, initializeRepoFiles } from '../lib/repo-init.js';
import { syncConnectionRepositories } from '../lib/repo-sync.js';
import {
  findUnknownMcpServerSlugs,
  findUnknownSkillSlugs,
  isAgentsMdSkill,
  libraryScopeWhere,
  loadAgentsMdTemplate,
  resolveAgentsMdFileContents,
  resolveMcpServerConfigs,
} from '../lib/task-skills.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { createRepoBodySchema, idParamsSchema, type CreateRepoBody } from './connection-schemas.js';

// POST /connections/:id/repositories: creates a repository on the provider
// behind a connection, seeds it with the planned init files, stores the
// skill selections, and kicks off the optional first init-prompt task.

// Creates the repo on the provider, re-syncs so the Repository row exists,
// then seeds it with the planned files (best-effort), stores the skill
// selections on the row and kicks off the optional first init-prompt task.
async function createAndSyncRepo(
  connection: GitConnection,
  input: CreateRepoBody,
  reply: FastifyReply,
): Promise<FastifyReply> {
  try {
    const client = getProviderClient(connection);
    const repository = await client.createRepo({ name: input.name, private: input.private });
    const sync = await syncConnectionRepositories(connection);
    const initialized = await initializeNewRepo(client, repository, input, connection.userId);
    await applyRepoSelections(connection.id, repository.fullName, input);
    const initTask = await startInitPromptTask(connection, repository.fullName, input, initialized);
    return reply.code(201).send({ repository, sync, initialized, initTask });
  } catch (err) {
    if (err instanceof ProviderError) {
      return reply.code(502).send({ error: `Failed to create repository: ${err.message}` });
    }
    throw err;
  }
}

// Legacy root-only pair: uploaded text wins, then the template skill.
async function resolveRootAgentsMd(input: CreateRepoBody, userId: string): Promise<string | null> {
  if (input.agentsMdContent) return input.agentsMdContent;
  if (!input.agentsMdSkillId) return null;
  return loadAgentsMdTemplate({ agentsMdSkillId: input.agentsMdSkillId }, userId);
}

// Per-folder AGENTS.md assignments; falls back to the legacy root-only pair.
async function resolveAgentsMdFiles(input: CreateRepoBody, userId: string) {
  if (!input.agentsMdFiles || input.agentsMdFiles.length === 0) {
    const content = await resolveRootAgentsMd(input, userId);
    return content ? [{ folder: '/', content }] : [];
  }
  return resolveAgentsMdFileContents(input.agentsMdFiles, userId);
}

// Selected skills as commit-ready SKILL.md inputs (kind 'skill' rows only —
// AGENTS.md templates are not materialized as skill packs).
async function resolveSkillFiles(input: CreateRepoBody, userId: string) {
  if (!input.skillSlugs || input.skillSlugs.length === 0) return [];
  return prisma.skill.findMany({
    where: { slug: { in: input.skillSlugs }, kind: 'skill', ...libraryScopeWhere(userId) },
    select: { slug: true, name: true, description: true, content: true },
  });
}

// Seeds the default branch with README.md / AGENTS.md / .agents/skills /
// .mcp.json; failures surface as warnings, never as a failed request.
async function initializeNewRepo(
  client: ReturnType<typeof getProviderClient>,
  repository: NormalizedRepo,
  input: CreateRepoBody,
  userId: string,
) {
  const files = buildRepoInitFiles({
    repoName: repository.name,
    readme: input.readme,
    agentsMdFiles: await resolveAgentsMdFiles(input, userId),
    skillFiles: await resolveSkillFiles(input, userId),
    mcpServers: await resolveMcpServerConfigs(input.mcpServerSlugs ?? [], userId),
  });
  return initializeRepoFiles(client, repository.fullName, repository.defaultBranch, files);
}

// Creates and enqueues the first init-prompt task on the freshly created
// repo. Null when no initPrompt was sent; failures become init warnings.
async function startInitPromptTask(
  connection: GitConnection,
  fullName: string,
  input: CreateRepoBody,
  initialized: { warnings: string[] },
): Promise<{ id: string } | null> {
  if (!input.initPrompt) return null;
  const repository = await prisma.repository.findFirst({
    where: { connectionId: connection.id, fullName },
    select: { id: true },
  });
  const llmConfig = await prisma.llmConfig.findFirst({
    where: { userId: connection.userId, isDefault: true, enabled: true },
    select: { id: true },
  });
  if (!repository || !llmConfig) {
    initialized.warnings.push('Init prompt not started: repository or default LLM config missing');
    return null;
  }
  const task = await prisma.task.create({
    data: {
      repositoryId: repository.id,
      kind: 'prompt',
      title: input.initPrompt.slice(0, 80),
      prompt: input.initPrompt,
      status: 'queued',
      llmConfigId: llmConfig.id,
      skills: input.skillSlugs ?? [],
    },
    select: { id: true },
  });
  await enqueueRunTask(task.id);
  return { id: task.id };
}

// Stores the skill selections on the synced Repository row. With a custom
// upload the agentsMdSkillId stays null — the file itself is in the repo, so
// the root-AGENTS.md check passes.
async function applyRepoSelections(
  connectionId: string,
  fullName: string,
  input: CreateRepoBody,
): Promise<void> {
  await prisma.repository.updateMany({
    where: { connectionId, fullName },
    data: {
      ...(input.skillSlugs !== undefined ? { skillSlugs: input.skillSlugs } : {}),
      ...(input.agentsMdSkillId && !input.agentsMdContent
        ? { agentsMdSkillId: input.agentsMdSkillId }
        : {}),
    },
  });
}

async function validateAgentsMdFiles(input: CreateRepoBody, userId: string): Promise<string | null> {
  for (const entry of input.agentsMdFiles ?? []) {
    if (entry.skillId && !(await isAgentsMdSkill(entry.skillId, userId))) {
      return `agentsMdFiles skillId does not reference an AGENTS.md skill: ${entry.skillId}`;
    }
  }
  return null;
}

// Creates a repository on the provider behind this connection
// (owner-checked like every other connection route).
export async function createConnectionRepo(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  const data = parseOrReply(createRepoBodySchema, request.body, reply, 'Invalid body', {
    includeIssues: true,
  });
  if (data === null) return;

  if (data.skillSlugs) {
    const unknown = await findUnknownSkillSlugs(data.skillSlugs, userId);
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `Unknown skill slug(s): ${unknown.join(', ')}` });
    }
  }
  if (data.agentsMdSkillId && !(await isAgentsMdSkill(data.agentsMdSkillId, userId))) {
    return reply
      .code(400)
      .send({ error: 'agentsMdSkillId does not reference an AGENTS.md skill' });
  }
  const agentsMdFilesError = await validateAgentsMdFiles(data, userId);
  if (agentsMdFilesError) {
    return reply.code(400).send({ error: agentsMdFilesError });
  }
  if (data.mcpServerSlugs) {
    const unknown = await findUnknownMcpServerSlugs(data.mcpServerSlugs, userId);
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `Unknown MCP server slug(s): ${unknown.join(', ')}` });
    }
  }

  const connection = await prisma.gitConnection.findFirst({
    where: { id: params.id, userId },
  });
  if (!connection) {
    return reply.code(404).send({ error: 'Connection not found' });
  }
  return createAndSyncRepo(connection, data, reply);
}
