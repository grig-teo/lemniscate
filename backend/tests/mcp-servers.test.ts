import { describe, expect, it } from 'vitest';
import { buildMcpServerWhere } from '../src/routes/mcp-servers.js';

describe('buildMcpServerWhere', () => {
  it('returns an empty filter when nothing was sent', () => {
    expect(buildMcpServerWhere({})).toEqual({});
  });

  it('matches search against slug, name and description case-insensitively', () => {
    expect(buildMcpServerWhere({ search: 'git' })).toEqual({
      OR: [
        { slug: { contains: 'git', mode: 'insensitive' } },
        { name: { contains: 'git', mode: 'insensitive' } },
        { description: { contains: 'git', mode: 'insensitive' } },
      ],
    });
  });

  it('treats blank search as no search', () => {
    expect(buildMcpServerWhere({ search: '  ' })).toEqual({});
  });
});
