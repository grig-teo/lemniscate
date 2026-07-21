import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma, Skill } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Read-only skills library: Hermes Agent skills (kind 'skill') and AGENTS.md
// templates (kind 'agents_md') seeded by scripts/seed-skills.ts.
// Register with prefix `/api/skills` (done in main.ts).

const LIST_LIMIT = 500;

const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
});

const slugParamSchema = z.object({ slug: z.string().min(1).max(200) });

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
// description and content case-insensitively; `category` is an exact filter;
// both combine with AND. Exported for unit tests (no DB on dev hosts).
export function buildSkillWhere(query: {
  search?: string;
  category?: string;
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
  return where;
}

async function listSkills(request: FastifyRequest, reply: FastifyReply) {
  const query = parseOrReply(listQuerySchema, request.query, reply, 'Invalid query');
  if (query === null) return;
  const skills: SkillSummary[] = await prisma.skill.findMany({
    where: buildSkillWhere(query),
    select: summarySelect,
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    take: LIST_LIMIT,
  });
  return { skills };
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

export default async function skillsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.get('/', listSkills);
  app.get('/categories', listCategories);
  app.get('/:slug', getSkill);
}
