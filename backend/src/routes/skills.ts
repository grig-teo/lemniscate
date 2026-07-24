import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma, Skill } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { mirrorLibraryObject, removeLibraryObject } from '../lib/library-storage.js';
import { requireAuth } from '../plugins/auth.js';
import { parseOrReply, parsePageQuery } from './helpers.js';

// Skills library: instruction packs (kind 'skill') and AGENTS.md templates
// (kind 'agents_md'). Seeded from external sources (e.g. hermes-agent) and
// editable through the CRUD endpoints below; every write is mirrored to
// MinIO (see lib/library-storage.ts).
// Register with prefix `/api/skills` (done in main.ts).

const LIST_LIMIT = 500;
const MAX_PAGE_SIZE = 50;

const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  kind: z.enum(['skill', 'agents_md']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

const slugParamSchema = z.object({ slug: z.string().min(1).max(200) });

const upsertBodySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case'),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
  content: z.string().min(1).max(200_000),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  source: z.string().min(1).max(100).default('lemniscate'),
  kind: z.enum(['skill', 'agents_md']).default('skill'),
});

// Fields exposed by the list endpoint — content is only served by GET /:slug.
const summarySelect = {
  id: true,
  slug: true,
  name: true,
  category: true,
  description: true,
  tags: true,
  kind: true,
} satisfies Prisma.SkillSelect;

type SkillSummary = Pick<
  Skill,
  'id' | 'slug' | 'name' | 'category' | 'description' | 'tags' | 'kind'
>;

// Maps the list query to a Prisma where clause. `search` matches name,
// description and content case-insensitively; `category` and `kind` are exact
// filters; all combine with AND. Exported for unit tests (no DB on dev hosts).
export function buildSkillWhere(query: {
  search?: string;
  category?: string;
  kind?: string;
}): Prisma.SkillWhereInput {
  const where: Prisma.SkillWhereInput = {};
  const search = query.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { content: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (query.category) {
    where.category = query.category;
  }
  if (query.kind) {
    where.kind = query.kind;
  }
  return where;
}

async function listSkills(request: FastifyRequest, reply: FastifyReply) {
  const query = parseOrReply(listQuerySchema, request.query, reply, 'Invalid query');
  if (query === null) return;
  const where = buildSkillWhere(query);
  const pageQuery = parsePageQuery(query);
  if (pageQuery === null) {
    const skills: SkillSummary[] = await prisma.skill.findMany({
      where,
      select: summarySelect,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: LIST_LIMIT,
    });
    return { skills };
  }
  const [skills, total] = await Promise.all([
    prisma.skill.findMany({
      where,
      select: summarySelect,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      skip: pageQuery.skip,
      take: pageQuery.take,
    }),
    prisma.skill.count({ where }),
  ]);
  return { skills, total, page: pageQuery.page, pageSize: pageQuery.pageSize };
}

async function listCategories() {
  const grouped = await prisma.skill.groupBy({
    by: ['category'],
    _count: { _all: true },
    orderBy: { category: 'asc' },
  });
  return {
    categories: grouped.map((row) => ({ name: row.category, count: row._count._all })),
  };
}

async function getSkill(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(slugParamSchema, request.params, reply, 'Invalid skill slug');
  if (params === null) return;
  const skill = await prisma.skill.findUnique({ where: { slug: params.slug } });
  if (!skill) {
    return reply.code(404).send({ error: 'Skill not found' });
  }
  return skill;
}

async function createSkill(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(upsertBodySchema, request.body, reply, 'Invalid body');
  if (body === null) return;
  const existing = await prisma.skill.findUnique({ where: { slug: body.slug } });
  if (existing) {
    return reply.code(409).send({ error: `Skill slug already exists: ${body.slug}` });
  }
  const skill = await prisma.skill.create({ data: body });
  await mirrorLibraryObject(skill.kind === 'agents_md' ? 'agents_md' : 'skill', skill.slug, skill.content, request.log);
  return reply.code(201).send({ skill });
}

async function updateSkill(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(slugParamSchema, request.params, reply, 'Invalid skill slug');
  if (params === null) return;
  const body = parseOrReply(upsertBodySchema.partial(), request.body, reply, 'Invalid body');
  if (body === null) return;
  const existing = await prisma.skill.findUnique({ where: { slug: params.slug } });
  if (!existing) {
    return reply.code(404).send({ error: 'Skill not found' });
  }
  const skill = await prisma.skill.update({
    where: { slug: params.slug },
    data: { ...body, slug: undefined },
  });
  await mirrorLibraryObject(skill.kind === 'agents_md' ? 'agents_md' : 'skill', skill.slug, skill.content, request.log);
  return { skill };
}

async function deleteSkill(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(slugParamSchema, request.params, reply, 'Invalid skill slug');
  if (params === null) return;
  const existing = await prisma.skill.findUnique({ where: { slug: params.slug } });
  if (!existing) {
    return reply.code(404).send({ error: 'Skill not found' });
  }
  await prisma.skill.delete({ where: { slug: params.slug } });
  await removeLibraryObject(existing.kind === 'agents_md' ? 'agents_md' : 'skill', existing.slug, request.log);
  return { deleted: true };
}

export default async function skillsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.get('/', listSkills);
  app.get('/categories', listCategories);
  app.get('/:slug', getSkill);
  app.post('/', createSkill);
  app.put('/:slug', updateSkill);
  app.delete('/:slug', deleteSkill);
}
