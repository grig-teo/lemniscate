import { describe, expect, it } from 'vitest';
import { buildSkillWhere } from '../src/routes/skills.js';

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
});
