import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { mirrorLibraryObject, removeLibraryObject } from '../lib/library-storage.js';
import { requireAuth } from '../plugins/auth.js';
import { parseOrReply, parsePageQuery } from './helpers.js';

// MCP server library: each row's `config` is the server fragment assembled
// into `.mcp.json` ("mcpServers": { "<slug>": <config> }) when the server is
// selected during repository creation. CRUD writes are mirrored to MinIO.
// Register with prefix `/api/mcp-servers` (done in main.ts).

const MAX_PAGE_SIZE = 50;

const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

const idParamSchema = z.object({ id: z.string().min(1) });

const upsertBodySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  config: z.record(z.unknown()),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  source: z.string().min(1).max(100).default('lemniscate'),
});

// `search` matches slug, name and description case-insensitively. Exported
// for unit tests (no DB on dev hosts).
export function buildMcpServerWhere(query: { search?: string }): Prisma.McpServerWhereInput {
  const search = query.search?.trim();
  if (!search) return {};
  return {
    OR: [
      { slug: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ],
  };
}

async function listServers(request: FastifyRequest, reply: FastifyReply) {
  const query = parseOrReply(listQuerySchema, request.query, reply, 'Invalid query');
  if (query === null) return;
  const where = buildMcpServerWhere(query);
  const pageQuery = parsePageQuery(query) ?? { skip: 0, take: MAX_PAGE_SIZE, page: 1, pageSize: MAX_PAGE_SIZE };
  const [servers, total] = await Promise.all([
    prisma.mcpServer.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: pageQuery.skip,
      take: pageQuery.take,
    }),
    prisma.mcpServer.count({ where }),
  ]);
  return { servers, total, page: pageQuery.page, pageSize: pageQuery.pageSize };
}

async function createServer(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(upsertBodySchema, request.body, reply, 'Invalid body');
  if (body === null) return;
  const existing = await prisma.mcpServer.findUnique({ where: { slug: body.slug } });
  if (existing) {
    return reply.code(409).send({ error: `MCP server slug already exists: ${body.slug}` });
  }
  const server = await prisma.mcpServer.create({
    data: { ...body, config: body.config as Prisma.InputJsonValue },
  });
  await mirrorLibraryObject('mcp_server', server.slug, JSON.stringify(server.config, null, 2), request.log);
  return reply.code(201).send({ server });
}

async function updateServer(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid id');
  if (params === null) return;
  const body = parseOrReply(upsertBodySchema.partial(), request.body, reply, 'Invalid body');
  if (body === null) return;
  const existing = await prisma.mcpServer.findUnique({ where: { id: params.id } });
  if (!existing) {
    return reply.code(404).send({ error: 'MCP server not found' });
  }
  const server = await prisma.mcpServer.update({
    where: { id: params.id },
    data: {
      ...body,
      slug: undefined,
      config: body.config as Prisma.InputJsonValue | undefined,
    },
  });
  await mirrorLibraryObject('mcp_server', server.slug, JSON.stringify(server.config, null, 2), request.log);
  return { server };
}

async function deleteServer(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid id');
  if (params === null) return;
  const existing = await prisma.mcpServer.findUnique({ where: { id: params.id } });
  if (!existing) {
    return reply.code(404).send({ error: 'MCP server not found' });
  }
  await prisma.mcpServer.delete({ where: { id: params.id } });
  await removeLibraryObject('mcp_server', existing.slug, request.log);
  return { deleted: true };
}

export default async function mcpServersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.get('/', listServers);
  app.post('/', createServer);
  app.put('/:id', updateServer);
  app.delete('/:id', deleteServer);
}
