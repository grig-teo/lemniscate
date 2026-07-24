import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for per-user library scoping on /api/skills and
// /api/mcp-servers: reads return global (userId NULL) + own rows; creates
// are stamped with the requester; PUT/DELETE are 403 on global or another
// user's rows; GET of another user's row is 404.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  skillFindMany: vi.fn(),
  skillFindUnique: vi.fn(),
  skillCreate: vi.fn(),
  skillUpdate: vi.fn(),
  skillDelete: vi.fn(),
  skillCount: vi.fn(),
  skillGroupBy: vi.fn(),
  mcpFindMany: vi.fn(),
  mcpFindUnique: vi.fn(),
  mcpCreate: vi.fn(),
  mcpUpdate: vi.fn(),
  mcpDelete: vi.fn(),
  mcpCount: vi.fn(),
  mirror: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    skill: {
      findMany: mocks.skillFindMany,
      findUnique: mocks.skillFindUnique,
      create: mocks.skillCreate,
      update: mocks.skillUpdate,
      delete: mocks.skillDelete,
      count: mocks.skillCount,
      groupBy: mocks.skillGroupBy,
    },
    mcpServer: {
      findMany: mocks.mcpFindMany,
      findUnique: mocks.mcpFindUnique,
      create: mocks.mcpCreate,
      update: mocks.mcpUpdate,
      delete: mocks.mcpDelete,
      count: mocks.mcpCount,
    },
  },
}));
vi.mock('../src/lib/library-storage.js', () => ({
  mirrorLibraryObject: mocks.mirror,
  removeLibraryObject: mocks.remove,
}));

import skillsRoutes from '../src/routes/skills.js';
import mcpServersRoutes from '../src/routes/mcp-servers.js';
import { signAuthToken } from '../src/plugins/auth.js';

const USER = 'user-1';
const SCOPE = { OR: [{ userId: null }, { userId: USER }] };

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(skillsRoutes, { prefix: '/api/skills' });
  await app.register(mcpServersRoutes, { prefix: '/api/mcp-servers' });
  return app;
}

function authed(app: Awaited<ReturnType<typeof buildApp>>, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    cookies: { lemniscate_token: signAuthToken(USER, 0) },
    ...(payload !== undefined ? { payload } : {}),
  });
}

const skillBody = {
  slug: 'my-skill',
  name: 'My Skill',
  category: 'research',
  content: 'do things',
};

const mcpBody = { slug: 'my-mcp', name: 'My MCP', config: { command: 'npx' } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: USER, sessionVersion: 0 });
  mocks.skillFindMany.mockResolvedValue([]);
  mocks.mcpFindMany.mockResolvedValue([]);
});

describe('scoped reads', () => {
  it('lists skills visible to the requester (global + own)', async () => {
    const app = await buildApp();
    const response = await authed(app, 'GET', '/api/skills/');
    expect(response.statusCode).toBe(200);
    expect(mocks.skillFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{}, SCOPE] } }),
    );
  });

  it('lists MCP servers visible to the requester (global + own)', async () => {
    const app = await buildApp();
    const response = await authed(app, 'GET', '/api/mcp-servers/');
    expect(response.statusCode).toBe(200);
    expect(mocks.mcpFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{}, SCOPE] } }),
    );
  });

  it('scopes the category counts to the requester', async () => {
    mocks.skillGroupBy.mockResolvedValue([]);
    const app = await buildApp();
    const response = await authed(app, 'GET', '/api/skills/categories');
    expect(response.statusCode).toBe(200);
    expect(mocks.skillGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: SCOPE }),
    );
  });

  it('404s a skill owned by another user', async () => {
    mocks.skillFindUnique.mockResolvedValue({ id: 's1', slug: 'theirs', userId: 'user-2' });
    const app = await buildApp();
    const response = await authed(app, 'GET', '/api/skills/theirs');
    expect(response.statusCode).toBe(404);
  });

  it('serves a global skill to any user', async () => {
    const skill = { id: 's0', slug: 'global-one', userId: null };
    mocks.skillFindUnique.mockResolvedValue(skill);
    const app = await buildApp();
    const response = await authed(app, 'GET', '/api/skills/global-one');
    expect(response.statusCode).toBe(200);
  });
});

describe('create stamping', () => {
  it('stamps new skills with the requester’s userId', async () => {
    mocks.skillFindUnique.mockResolvedValue(null);
    mocks.skillCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: 's1', ...data }));
    const app = await buildApp();
    const response = await authed(app, 'POST', '/api/skills/', skillBody);
    expect(response.statusCode).toBe(201);
    expect(mocks.skillCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER }),
    });
  });

  it('stamps new MCP servers with the requester’s userId', async () => {
    mocks.mcpFindUnique.mockResolvedValue(null);
    mocks.mcpCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: 'm1', ...data }));
    const app = await buildApp();
    const response = await authed(app, 'POST', '/api/mcp-servers/', mcpBody);
    expect(response.statusCode).toBe(201);
    expect(mocks.mcpCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER }),
    });
  });
});

describe('mutation ownership', () => {
  it('403s PUT on a global skill', async () => {
    mocks.skillFindUnique.mockResolvedValue({ id: 's0', slug: 'global-one', userId: null });
    const app = await buildApp();
    const response = await authed(app, 'PUT', '/api/skills/global-one', { name: 'x' });
    expect(response.statusCode).toBe(403);
    expect(mocks.skillUpdate).not.toHaveBeenCalled();
  });

  it('403s PUT on another user’s skill', async () => {
    mocks.skillFindUnique.mockResolvedValue({ id: 's1', slug: 'theirs', userId: 'user-2' });
    const app = await buildApp();
    const response = await authed(app, 'PUT', '/api/skills/theirs', { name: 'x' });
    expect(response.statusCode).toBe(403);
    expect(mocks.skillUpdate).not.toHaveBeenCalled();
  });

  it('allows PUT on own skill', async () => {
    mocks.skillFindUnique.mockResolvedValue({ id: 's1', slug: 'my-skill', userId: USER });
    mocks.skillUpdate.mockResolvedValue({ id: 's1', slug: 'my-skill', userId: USER, kind: 'skill', content: 'c' });
    const app = await buildApp();
    const response = await authed(app, 'PUT', '/api/skills/my-skill', { name: 'x' });
    expect(response.statusCode).toBe(200);
  });

  it('403s DELETE on another user’s skill', async () => {
    mocks.skillFindUnique.mockResolvedValue({ id: 's1', slug: 'theirs', userId: 'user-2' });
    const app = await buildApp();
    const response = await authed(app, 'DELETE', '/api/skills/theirs');
    expect(response.statusCode).toBe(403);
    expect(mocks.skillDelete).not.toHaveBeenCalled();
  });

  it('403s PUT on a global MCP server', async () => {
    mocks.mcpFindUnique.mockResolvedValue({ id: 'm0', slug: 'filesystem', userId: null });
    const app = await buildApp();
    const response = await authed(app, 'PUT', '/api/mcp-servers/m0', { name: 'x' });
    expect(response.statusCode).toBe(403);
    expect(mocks.mcpUpdate).not.toHaveBeenCalled();
  });

  it('403s DELETE on another user’s MCP server', async () => {
    mocks.mcpFindUnique.mockResolvedValue({ id: 'm1', slug: 'theirs', userId: 'user-2' });
    const app = await buildApp();
    const response = await authed(app, 'DELETE', '/api/mcp-servers/m1');
    expect(response.statusCode).toBe(403);
    expect(mocks.mcpDelete).not.toHaveBeenCalled();
  });

  it('allows DELETE on own MCP server', async () => {
    mocks.mcpFindUnique.mockResolvedValue({ id: 'm1', slug: 'my-mcp', userId: USER });
    mocks.mcpDelete.mockResolvedValue({});
    const app = await buildApp();
    const response = await authed(app, 'DELETE', '/api/mcp-servers/m1');
    expect(response.statusCode).toBe(200);
  });
});
