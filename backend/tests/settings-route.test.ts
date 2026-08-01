import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings route: GET /api/settings reports the effective core agent
// executor (per-user override ?? AGENT_EXECUTOR env default) and
// PUT /api/settings/agent-executor stores the per-user override chosen in
// Settings → Agent.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate },
  },
}));

import settingsRoutes from '../src/routes/settings.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  return app;
}

function authCookies() {
  return { lemniscate_token: signAuthToken('user-1', 0) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // requireAuth's session check; agentExecutor rides along for the handler.
  mocks.userFindUnique.mockResolvedValue({
    id: 'user-1',
    sessionVersion: 0,
    agentExecutor: null,
  });
  mocks.userUpdate.mockImplementation(
    async ({ data }: { data: { agentExecutor: string } }) => ({
      id: 'user-1',
      sessionVersion: 0,
      agentExecutor: data.agentExecutor,
    }),
  );
});

describe('GET /api/settings', () => {
  it('rejects unauthenticated requests', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/settings/' });
    expect(response.statusCode).toBe(401);
  });

  it('reports the env default when the user has no override', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/',
      cookies: authCookies(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agentExecutor: 'lemcore',
      defaultAgentExecutor: 'lemcore',
      override: null,
    });
  });

  it('reports the stored override as the effective executor', async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: 'user-1',
      sessionVersion: 0,
      agentExecutor: 'lemcore',
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/',
      cookies: authCookies(),
    });
    expect(response.json()).toEqual({
      agentExecutor: 'lemcore',
      defaultAgentExecutor: 'lemcore',
      override: 'lemcore',
    });
  });

  it('degrades a stale stored executor (hermes/internal removed) to the default', async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: 'user-1',
      sessionVersion: 0,
      agentExecutor: 'hermes',
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/',
      cookies: authCookies(),
    });
    expect(response.json()).toEqual({
      agentExecutor: 'lemcore',
      defaultAgentExecutor: 'lemcore',
      override: null,
    });
  });
});

describe('PUT /api/settings/agent-executor', () => {
  it('persists the chosen executor and returns the refreshed settings', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/agent-executor',
      cookies: authCookies(),
      payload: { agentExecutor: 'lemcore' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { agentExecutor: 'lemcore' },
      select: { agentExecutor: true },
    });
    expect(response.json()).toEqual({
      agentExecutor: 'lemcore',
      defaultAgentExecutor: 'lemcore',
      override: 'lemcore',
    });
  });

  it('rejects an unknown executor with 400', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/agent-executor',
      cookies: authCookies(),
      payload: { agentExecutor: 'codex' },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
