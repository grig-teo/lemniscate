import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the WS gateway's message handling, extracted as pure-ish
// helpers (parseAgentMessage / handleAgentMessage) so no live socket is
// needed — app.inject cannot drive WebSocket upgrades.

const mocks = vi.hoisted(() => ({
  deviceFindUnique: vi.fn(),
  deviceUpdate: vi.fn(),
  commandUpdateMany: vi.fn(),
  commandFindFirst: vi.fn(),
  commandCreate: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    device: { findUnique: mocks.deviceFindUnique, update: mocks.deviceUpdate },
    deviceCommand: {
      updateMany: mocks.commandUpdateMany,
      findFirst: mocks.commandFindFirst,
      create: mocks.commandCreate,
    },
  },
}));

import { handleAgentMessage, parseAgentMessage } from '../src/routes/devices.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseAgentMessage', () => {
  it('parses hello, heartbeat and command_result', () => {
    expect(parseAgentMessage('{"type":"hello","meta":{"os":"linux"}}')).toEqual({
      type: 'hello',
      meta: { os: 'linux' },
    });
    expect(parseAgentMessage('{"type":"heartbeat"}')).toEqual({ type: 'heartbeat' });
    expect(parseAgentMessage('{"type":"command_result","id":"c1","status":"done"}')).toEqual({
      type: 'command_result',
      id: 'c1',
      status: 'done',
    });
  });

  it('rejects invalid JSON, unknown types and bad statuses', () => {
    expect(parseAgentMessage('not json')).toBeNull();
    expect(parseAgentMessage('{"type":"hack"}')).toBeNull();
    expect(parseAgentMessage('{"type":"command_result","id":"c1","status":"queued"}')).toBeNull();
    expect(parseAgentMessage('{"type":"command_result","status":"done"}')).toBeNull();
  });
});

describe('handleAgentMessage', () => {
  it('heartbeat only touches lastSeenAt', async () => {
    const touch = vi.fn().mockResolvedValue(undefined);
    await handleAgentMessage('dev-1', { type: 'heartbeat' }, touch);
    expect(touch).toHaveBeenCalledOnce();
    expect(mocks.deviceUpdate).not.toHaveBeenCalled();
    expect(mocks.commandUpdateMany).not.toHaveBeenCalled();
  });

  it('hello merges meta into the existing device meta', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ meta: { os: 'linux', arch: 'arm64' } });
    const touch = vi.fn().mockResolvedValue(undefined);
    await handleAgentMessage('dev-1', { type: 'hello', meta: { dockerAvailable: true } }, touch);
    expect(mocks.deviceUpdate).toHaveBeenCalledWith({
      where: { id: 'dev-1' },
      data: { meta: { os: 'linux', arch: 'arm64', dockerAvailable: true } },
    });
    expect(touch).toHaveBeenCalledOnce();
  });

  it('hello without meta just touches', async () => {
    const touch = vi.fn().mockResolvedValue(undefined);
    await handleAgentMessage('dev-1', { type: 'hello' }, touch);
    expect(mocks.deviceFindUnique).not.toHaveBeenCalled();
    expect(touch).toHaveBeenCalledOnce();
  });

  it('command_result updates only a command of this device', async () => {
    const touch = vi.fn().mockResolvedValue(undefined);
    await handleAgentMessage(
      'dev-1',
      { type: 'command_result', id: 'cmd-1', status: 'done', result: { url: 'http://x' } },
      touch,
    );
    expect(mocks.commandUpdateMany).toHaveBeenCalledWith({
      where: { id: 'cmd-1', deviceId: 'dev-1' },
      data: { status: 'done', result: { url: 'http://x' } },
    });
    expect(touch).not.toHaveBeenCalled();
  });
});

describe('build→install chaining', () => {
  const buildCommand = {
    id: 'cmd-build',
    deviceId: 'dev-builder',
    type: 'build_android',
    payload: { repoUrl: 'https://github.com/a/b', installDeviceId: 'dev-phone', appName: 'B' },
  };

  it('creates and dispatches install_apk with a backend download URL after a done build', async () => {
    mocks.commandFindFirst.mockResolvedValue(buildCommand);
    mocks.commandCreate.mockImplementation(async ({ data }: { data: object }) => ({
      id: 'cmd-install',
      status: 'queued',
      ...data,
    }));
    const touch = vi.fn().mockResolvedValue(undefined);
    await handleAgentMessage(
      'dev-builder',
      {
        type: 'command_result',
        id: 'cmd-build',
        status: 'done',
        result: { artifactKey: 'dev-builder/u1-app.apk' },
      },
      touch,
    );
    expect(mocks.commandCreate).toHaveBeenCalledWith({
      data: {
        deviceId: 'dev-phone',
        type: 'install_apk',
        payload: {
          apkUrl: 'http://localhost:3000/api/devices/artifacts/dev-builder/u1-app.apk',
          appName: 'B',
        },
      },
    });
  });

  it('does not chain on failed builds or non-build commands', async () => {
    mocks.commandFindFirst.mockResolvedValue(buildCommand);
    const touch = vi.fn().mockResolvedValue(undefined);
    await handleAgentMessage(
      'dev-builder',
      { type: 'command_result', id: 'cmd-build', status: 'failed', result: { error: 'x' } },
      touch,
    );
    mocks.commandFindFirst.mockResolvedValue({ ...buildCommand, type: 'run_web' });
    await handleAgentMessage(
      'dev-builder',
      { type: 'command_result', id: 'cmd-build', status: 'done', result: { artifactKey: 'k' } },
      touch,
    );
    expect(mocks.commandCreate).not.toHaveBeenCalled();
  });
});
