import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/tasks/:id/run-targets: device items carry meta so the frontend
// can read meta.environment (the agent-reported adb/iOS run targets).

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  deviceFindMany: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: { findFirst: mocks.taskFindFirst },
    device: { findMany: mocks.deviceFindMany },
  },
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  getAgentTasksQueue: () => ({ add: vi.fn() }),
  enqueueRunTask: vi.fn(),
  JOB_PRIORITY: { userTask: 1, review: 2, background: 10 },
}));

import tasksRoutes from '../src/routes/tasks.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(tasksRoutes, { prefix: '/api' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } };

const DEVICE_META = { environment: { androidDevices: [{ serial: 'emulator-5554', transport: 'usb' }] } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.taskFindFirst.mockResolvedValue({
    changedPaths: ['android/app/build.gradle'],
    repository: { platform: 'android' },
  });
  mocks.deviceFindMany.mockResolvedValue([
    { id: 'dev-1', name: 'pixel', platform: 'android', meta: DEVICE_META, lastSeenAt: new Date() },
  ]);
});

describe('GET /api/tasks/:id/run-targets', () => {
  it('includes device meta so the frontend can read meta.environment', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/tasks/t1/run-targets', ...AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const android = body.targets.find((t: { target: string }) => t.target === 'android');
    expect(android.commandType).toBe('build_android');
    expect(android.devices).toEqual([
      { id: 'dev-1', name: 'pixel', platform: 'android', online: true, meta: DEVICE_META },
    ]);
  });
});
