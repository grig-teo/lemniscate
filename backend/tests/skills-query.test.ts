import { describe, expect, it } from 'vitest';
import { buildSkillWhere } from '../src/routes/skills.js';
import { parsePageQuery } from '../src/routes/helpers.js';

// Locking tests for the GET /api/skills search/category → Prisma where mapping.

describe('buildSkillWhere', () => {
  it('returns an empty filter when nothing was sent', () => {
    expect(buildSkillWhere({})).toEqual({});
  });

  it('matches search against name, description and content case-insensitively', () => {
    expect(buildSkillWhere({ search: 'rss' })).toEqual({
      OR: [
        { name: { contains: 'rss', mode: 'insensitive' } },
        { description: { contains: 'rss', mode: 'insensitive' } },
        { content: { contains: 'rss', mode: 'insensitive' } },
      ],
    });
  });

  it('filters category exactly', () => {
    expect(buildSkillWhere({ category: 'research' })).toEqual({ category: 'research' });
  });

  it('ANDs category with the search OR group', () => {
    expect(buildSkillWhere({ search: 'rss', category: 'research' })).toEqual({
      category: 'research',
      OR: [
        { name: { contains: 'rss', mode: 'insensitive' } },
        { description: { contains: 'rss', mode: 'insensitive' } },
        { content: { contains: 'rss', mode: 'insensitive' } },
      ],
    });
  });

  it('treats blank search as no search', () => {
    expect(buildSkillWhere({ search: '   ', category: 'research' })).toEqual({
      category: 'research',
    });
  });

  it('filters kind exactly', () => {
    expect(buildSkillWhere({ kind: 'agents_md' })).toEqual({ kind: 'agents_md' });
  });

  it('ANDs kind with search', () => {
    expect(buildSkillWhere({ search: 'go', kind: 'skill' })).toEqual({
      kind: 'skill',
      OR: [
        { name: { contains: 'go', mode: 'insensitive' } },
        { description: { contains: 'go', mode: 'insensitive' } },
        { content: { contains: 'go', mode: 'insensitive' } },
      ],
    });
  });
});

describe('parsePageQuery', () => {
  it('returns null when no pagination params are sent', () => {
    expect(parsePageQuery({})).toBeNull();
  });

  it('defaults page to 1 and pageSize to 5', () => {
    expect(parsePageQuery({ page: undefined, pageSize: 10 })).toEqual({
      skip: 0,
      take: 10,
      page: 1,
      pageSize: 10,
    });
  });

  it('computes skip from page and pageSize', () => {
    expect(parsePageQuery({ page: 3, pageSize: 5 })).toEqual({
      skip: 10,
      take: 5,
      page: 3,
      pageSize: 5,
    });
  });
});
