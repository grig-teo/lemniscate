import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Unit tests for the WS gateway's message handling, extracted as pure-ish
// helpers (parseAgentMessage / handleAgentMessage) so no live socket is
// needed — app.inject cannot drive WebSocket upgrades.
//
// The parseAgentMessage cases are driven by the shared protocol fixtures in
// tests/contract/device-ws/ — the same JSON files decoded by the Node agent
// (agent/lib.test.js) and the Tauri agent (protocol.rs). See the README in
// that directory for the full contract.

/** Walk up from cwd to locate the repo-rooted fixture directory. */
function fixtureDir(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, 'tests', 'contract', 'device-ws');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('tests/contract/device-ws/ not found');
    dir = parent;
  }
}

interface Fixture {
  _comment: string;
  direction: string;
  frame?: unknown;
  closeCode?: number;
  reason?: string;
}

/** Read one fixture by basename (e.g. "hello.json"). */
function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(resolve(fixtureDir(), name), 'utf8'));
}

/** Every fixture listed in index.json, parsed. */
function loadAllFixtures(): Fixture[] {
  const index = JSON.parse(readFileSync(resolve(fixtureDir(), 'index.json'), 'utf8'));
  return (index.fixtures as string[]).map(loadFixture);
}

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

describe('parseAgentMessage — shared contract fixtures', () => {
  // Every client-to-server fixture in tests/contract/device-ws/ must
  // round-trip: parse → re-serialize → structural equality. This replaces
  // the former inline-JSON cases that duplicated agent/lib.test.js.
  const clientFrames = loadAllFixtures().filter((f) => f.direction === 'client-to-server');

  it('round-trips every client-to-server fixture', () => {
    expect(clientFrames.length).toBeGreaterThanOrEqual(6);
    for (const fixture of clientFrames) {
      const raw = JSON.stringify(fixture.frame);
      const parsed = parseAgentMessage(raw);
      expect(parsed, fixture._comment).not.toBeNull();
      // Re-serialize to confirm structural equality (catches field drift).
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(fixture.frame);
    }
  });

  it('rejects invalid JSON, unknown types and bad statuses', () => {
    expect(parseAgentMessage('not json')).toBeNull();
    expect(parseAgentMessage('{"type":"hack"}')).toBeNull();
    expect(parseAgentMessage('{"type":"command_result","id":"c1","status":"queued"}')).toBeNull();
    expect(parseAgentMessage('{"type":"command_result","status":"done"}')).toBeNull();
  });

  it('capabilities defaults the lists and strips unknown fields', () => {
    const raw = JSON.stringify({
      type: 'capabilities',
      capabilities: { dockerAvailable: false, futureField: 42 },
    });
    expect(parseAgentMessage(raw)).toEqual({
      type: 'capabilities',
      capabilities: {
        dockerAvailable: false,
        androidDevices: [],
        iosDevices: [],
        simulators: [],
        emulators: [],
      },
    });
  });

  it('rejects malformed capabilities', () => {
    expect(parseAgentMessage('{"type":"capabilities"}')).toBeNull();
    expect(parseAgentMessage('{"type":"capabilities","capabilities":"nope"}')).toBeNull();
    const badDevice = JSON.stringify({
      type: 'capabilities',
      capabilities: { androidDevices: [{ serial: 'x', transport: 'carrier-pigeon' }] },
    });
    expect(parseAgentMessage(badDevice)).toBeNull();
  });

  it('close-4001 fixture documents the token-rejection close code', () => {
    const close = loadFixture('close-4001.json');
    expect(close.direction).toBe('close');
    expect(close.closeCode).toBe(4001);
    expect(close.reason).toBe('invalid device token');
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

  it('capabilities merges into meta under the environment key', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ meta: { os: 'darwin' } });
    const touch = vi.fn().mockResolvedValue(undefined);
    const capabilities = {
      dockerAvailable: true,
      androidDevices: [{ serial: '0a1b', transport: 'usb' as const }],
      iosDevices: [],
      simulators: [],
      emulators: [],
    };
    await handleAgentMessage('dev-1', { type: 'capabilities', capabilities }, touch);
    expect(mocks.deviceUpdate).toHaveBeenCalledWith({
      where: { id: 'dev-1' },
      data: { meta: { os: 'darwin', environment: capabilities } },
    });
    expect(touch).toHaveBeenCalledOnce();
  });

  it('capabilities replaces a previous environment report', async () => {
    mocks.deviceFindUnique.mockResolvedValue({
      meta: { environment: { dockerAvailable: false, androidDevices: [], iosDevices: [], simulators: [], emulators: [] } },
    });
    const touch = vi.fn().mockResolvedValue(undefined);
    const capabilities = {
      dockerAvailable: true,
      androidDevices: [],
      iosDevices: [],
      simulators: [],
      emulators: [{ name: 'Pixel_API_35' }],
    };
    await handleAgentMessage('dev-1', { type: 'capabilities', capabilities }, touch);
    expect(mocks.deviceUpdate).toHaveBeenCalledWith({
      where: { id: 'dev-1' },
      data: { meta: { environment: capabilities } },
    });
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
