import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for DELETE /api/repositories/:id: ownership-scoped delete
// (prisma mocked; auth follows the notifications-routes.test.ts pattern).

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  repositoryFindFirst: vi.fn(),
  repositoryDelete: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    repository: {
      findFirst: mocks.repositoryFindFirst,
      delete: mocks.repositoryDelete,
    },
  },
}));

import repositoryDeleteRoutes from '../src/routes/repository-delete.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(repositoryDeleteRoutes, { prefix: '/api' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.repositoryFindFirst.mockResolvedValue({ id: 'repo-1' });
  mocks.repositoryDelete.mockResolvedValue({ id: 'repo-1' });
});

describe('DELETE /api/repositories/:id', () => {
  it('deletes an owned repository and answers 204', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/repositories/repo-1', ...AUTH });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(mocks.repositoryFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', connection: { userId: 'user-1' } },
      select: { id: true },
    });
    expect(mocks.repositoryDelete).toHaveBeenCalledWith({ where: { id: 'repo-1' } });
  });

  it('answers 404 and does not delete a repository the user does not own', async () => {
    mocks.repositoryFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/repositories/repo-9', ...AUTH });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Repository not found' });
    expect(mocks.repositoryDelete).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/repositories/repo-1' });

    expect(res.statusCode).toBe(401);
    expect(mocks.repositoryDelete).not.toHaveBeenCalled();
  });
});
