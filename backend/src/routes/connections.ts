import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { GitConnection, Prisma } from '@prisma/client';
import { z } from 'zod';
import { encrypt } from '../lib/crypto.js';
import {
  fetchProviderProfile,
  getProviderClient,
  ProviderError,
  type NormalizedRepo,
  type ProviderName,
} from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import { enqueueRunTask } from '../lib/proposal-scheduler.js';
import { buildRepoInitFiles, initializeRepoFiles } from '../lib/repo-init.js';
import {
  syncConnectionByIdBestEffort,
  syncConnectionRepositories,
} from '../lib/repo-sync.js';
import {
  findUnknownSkillSlugs,
  isAgentsMdSkill,
  loadAgentsMdTemplate,
} from '../lib/task-skills.js';
import {
  AUTH_COOKIE,
  authenticatedUserId,
  requireAuth,
  setAuthCookie,
  verifyAuthToken,
} from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Never leak the encrypted (or decrypted) token to clients.
const connectionSelect = {
  id: true,
  provider: true,
  baseUrl: true,
  username: true,
} as const;

const connectBodySchema = z.object({
  provider: z.enum(['github', 'gitverse', 'gitlab', 'gitee']),
  token: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

// POST /connections/:id/repositories body. Exported for tests.
export const createRepoBodySchema = z.object({
  name: z.string().min(1).max(100),
  private: z.boolean().optional(),
  // Slugs of skills injected into the agent's system prompt for tasks on
  // this repository AND committed as .agents/skills/<slug>/SKILL.md files;
  // existence validated against the Skill table below.
  skillSlugs: z.array(z.string().min(1)).max(20).optional(),
  // AGENTS.md assignments per folder: '/' is the root file, nested folders
  // get <folder>/AGENTS.md. `content` (uploaded custom text) wins over
  // `skillId` (an agents_md template). When omitted entirely, the legacy
  // agentsMdContent/agentsMdSkillId pair below seeds the root file.
  agentsMdFiles: z
    .array(
      z.object({
        folder: z.string().min(1).max(500),
        skillId: z.string().min(1).optional(),
        content: z.string().max(100_000).optional(),
      }),
    )
    .max(50)
    .optional(),
  // AGENTS.md template skill (kind 'agents_md') committed as AGENTS.md on
  // creation; null means "no template".
  agentsMdSkillId: z.string().min(1).nullable().optional(),
  // Uploaded custom AGENTS.md text; wins over agentsMdSkillId.
  agentsMdContent: z.string().max(100_000).optional(),
  // Slugs of McpServer rows assembled into a root .mcp.json.
  mcpServerSlugs: z.array(z.string().min(1)).max(20).optional(),
  // First project prompt: after creation + seeding, a prompt task is
  // created on the new repository and started immediately.
  initPrompt: z.string().min(1).max(8000).optional(),
  // Seed the repo with a README.md (default: yes).
  readme: z.boolean().default(true),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

// Like requireAuth but never rejects: sets request.userId when the session
// cookie is present and valid, leaves it undefined otherwise. Used by
// POST /connections, which doubles as GitVerse-first login.
async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) return;
  try {
    const userId = verifyAuthToken(token);
    if (!userId) return;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      request.userId = user.id;
    }
  } catch {
    // Invalid/expired token: treat as unauthenticated.
  }
}

// Validates the token against the provider. Returns the provider username,
// or null after sending a 400 on ProviderError.
async function validatedUsername(
  provider: ProviderName,
  token: string,
  baseUrl: string | undefined,
  reply: FastifyReply,
): Promise<string | null> {
  try {
    const profile = await fetchProviderProfile(provider, token, baseUrl);
    return profile.username;
  } catch (err) {
    if (err instanceof ProviderError) {
      void reply.code(400).send({ error: `Token validation failed: ${err.message}` });
      return null;
    }
    throw err;
  }
}

type ConnectionView = Prisma.GitConnectionGetPayload<{ select: typeof connectionSelect }>;

// Authenticated path: the connection belongs to the session user.
async function upsertAuthenticatedConnection(
  userId: string,
  provider: ProviderName,
  username: string,
  baseUrl: string | undefined,
  accessTokenEnc: string,
): Promise<{ connection: ConnectionView; created: boolean }> {
  const existing = await prisma.gitConnection.findFirst({
    where: { userId, provider, username, baseUrl: baseUrl ?? null },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      // A PAT replaces any OAuth tokens: clear the refresh flow's fields.
      data: { accessTokenEnc, tokenType: 'pat', refreshTokenEnc: null, tokenExpiresAt: null },
      select: connectionSelect,
    });
    return { connection, created: false };
  }
  const connection = await prisma.gitConnection.create({
    data: { userId, provider, username, baseUrl: baseUrl ?? null, accessTokenEnc },
    select: connectionSelect,
  });
  return { connection, created: true };
}

// Unauthenticated path: the PAT is the credential — find the user behind
// this connection and start a session. No open registration: an unknown PAT
// identity is rejected with 401 instead of creating an account.
async function connectByPatIdentity(
  provider: ProviderName,
  username: string,
  baseUrl: string | undefined,
  accessTokenEnc: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username, baseUrl: baseUrl ?? null },
  });
  if (!existing) {
    return reply.code(401).send({ error: 'No account matches this token' });
  }
  const connection = await prisma.gitConnection.update({
    where: { id: existing.id },
    // A PAT replaces any OAuth tokens: clear the refresh flow's fields.
    data: { accessTokenEnc, tokenType: 'pat', refreshTokenEnc: null, tokenExpiresAt: null },
    select: connectionSelect,
  });
  setAuthCookie(reply, existing.userId);
  await syncConnectionByIdBestEffort(connection.id, request.log);
  return reply.code(200).send({ connection });
}

async function listConnections(request: FastifyRequest) {
  const userId = authenticatedUserId(request);
  const connections = await prisma.gitConnection.findMany({
    where: { userId },
    select: {
      ...connectionSelect,
      _count: { select: { repositories: true } },
    },
    orderBy: { provider: 'asc' },
  });
  return { connections };
}

// PAT-based connect (the only option for GitVerse; also works for
// GitHub/GitLab). Validates the token against the provider before storing.
//
// Doubles as login when no session exists: without a valid auth cookie the
// PAT identifies the user — the connection must already exist (this route
// never creates accounts) and a JWT session cookie is set. With a session it
// attaches the connection to the authenticated user as before.
async function connectWithPat(request: FastifyRequest, reply: FastifyReply) {
  const data = parseOrReply(connectBodySchema, request.body, reply, 'Invalid body', {
    includeIssues: true,
  });
  if (data === null) return;
  const { provider, token, baseUrl } = data;
  if (provider !== 'gitverse' && baseUrl) {
    return reply.code(400).send({ error: 'baseUrl is only supported for gitverse connections' });
  }

  const username = await validatedUsername(provider, token, baseUrl, reply);
  if (username === null) return;
  const accessTokenEnc = encrypt(token);

  if (request.userId) {
    const { connection, created } = await upsertAuthenticatedConnection(
      request.userId,
      provider,
      username,
      baseUrl,
      accessTokenEnc,
    );
    await syncConnectionByIdBestEffort(connection.id, request.log);
    return reply.code(created ? 201 : 200).send({ connection });
  }
  return connectByPatIdentity(provider, username, baseUrl, accessTokenEnc, request, reply);
}

async function deleteConnection(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  // Repositories cascade-delete with the connection.
  const { count } = await prisma.gitConnection.deleteMany({
    where: { id: params.id, userId },
  });
  if (count === 0) {
    return reply.code(404).send({ error: 'Connection not found' });
  }
  return reply.code(204).send();
}

// Pulls the provider's repo list and upserts Repository rows keyed by
// (connectionId, externalId).
async function syncConnectionRepos(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;

  const connection = await prisma.gitConnection.findFirst({
    where: { id: params.id, userId },
  });
  if (!connection) {
    return reply.code(404).send({ error: 'Connection not found' });
  }

  try {
    return await syncConnectionRepositories(connection);
  } catch (err) {
    if (err instanceof ProviderError) {
      return reply.code(502).send({ error: `Failed to list repositories: ${err.message}` });
    }
    throw err;
  }
}

type CreateRepoBody = z.infer<typeof createRepoBodySchema>;

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
    const initialized = await initializeNewRepo(client, repository, input);
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
async function resolveRootAgentsMd(input: CreateRepoBody): Promise<string | null> {
  if (input.agentsMdContent) return input.agentsMdContent;
  if (!input.agentsMdSkillId) return null;
  return loadAgentsMdTemplate({ agentsMdSkillId: input.agentsMdSkillId });
}

// Per-folder AGENTS.md assignments; falls back to the legacy root-only pair.
async function resolveAgentsMdFiles(input: CreateRepoBody) {
  if (!input.agentsMdFiles || input.agentsMdFiles.length === 0) {
    const content = await resolveRootAgentsMd(input);
    return content ? [{ folder: '/', content }] : [];
  }
  const files: { folder: string; content: string }[] = [];
  for (const entry of input.agentsMdFiles) {
    const content = entry.content ?? (entry.skillId ? await loadAgentsMdTemplate({ agentsMdSkillId: entry.skillId }) : null);
    if (content) files.push({ folder: entry.folder, content });
  }
  return files;
}

// Selected skills as commit-ready SKILL.md inputs (kind 'skill' rows only —
// AGENTS.md templates are not materialized as skill packs).
async function resolveSkillFiles(input: CreateRepoBody) {
  if (!input.skillSlugs || input.skillSlugs.length === 0) return [];
  return prisma.skill.findMany({
    where: { slug: { in: input.skillSlugs }, kind: 'skill' },
    select: { slug: true, name: true, description: true, content: true },
  });
}

// Selected MCP servers as the `.mcp.json` "mcpServers" map (slug → config).
async function resolveMcpServers(input: CreateRepoBody): Promise<Record<string, unknown>> {
  if (!input.mcpServerSlugs || input.mcpServerSlugs.length === 0) return {};
  const rows = await prisma.mcpServer.findMany({
    where: { slug: { in: input.mcpServerSlugs } },
    select: { slug: true, config: true },
  });
  return Object.fromEntries(rows.map((row) => [row.slug, row.config]));
}

// Seeds the default branch with README.md / AGENTS.md / .agents/skills /
// .mcp.json; failures surface as warnings, never as a failed request.
async function initializeNewRepo(
  client: ReturnType<typeof getProviderClient>,
  repository: NormalizedRepo,
  input: CreateRepoBody,
) {
  const files = buildRepoInitFiles({
    repoName: repository.name,
    readme: input.readme,
    agentsMdFiles: await resolveAgentsMdFiles(input),
    skillFiles: await resolveSkillFiles(input),
    mcpServers: await resolveMcpServers(input),
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

async function findUnknownMcpServerSlugs(slugs: string[]): Promise<string[]> {
  const rows = await prisma.mcpServer.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true },
  });
  const known = new Set(rows.map((row) => row.slug));
  return slugs.filter((slug) => !known.has(slug));
}

async function validateAgentsMdFiles(input: CreateRepoBody): Promise<string | null> {
  for (const entry of input.agentsMdFiles ?? []) {
    if (entry.skillId && !(await isAgentsMdSkill(entry.skillId))) {
      return `agentsMdFiles skillId does not reference an AGENTS.md skill: ${entry.skillId}`;
    }
  }
  return null;
}

// POST /connections/:id/repositories — creates a repository on the provider
// behind this connection (owner-checked like every other connection route).
async function createConnectionRepo(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  const data = parseOrReply(createRepoBodySchema, request.body, reply, 'Invalid body', {
    includeIssues: true,
  });
  if (data === null) return;

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
  const agentsMdFilesError = await validateAgentsMdFiles(data);
  if (agentsMdFilesError) {
    return reply.code(400).send({ error: agentsMdFilesError });
  }
  if (data.mcpServerSlugs) {
    const unknown = await findUnknownMcpServerSlugs(data.mcpServerSlugs);
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

const connectionsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/connections', { preHandler: requireAuth }, listConnections);
  app.post('/connections', { preHandler: optionalAuth }, connectWithPat);
  app.delete('/connections/:id', { preHandler: requireAuth }, deleteConnection);
  app.post('/connections/:id/sync', { preHandler: requireAuth }, syncConnectionRepos);
  app.post('/connections/:id/repositories', { preHandler: requireAuth }, createConnectionRepo);
};

export default connectionsRoutes;
