import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as lib from './lib.js';

// --- buildWsUrl ---------------------------------------------------------------

test('buildWsUrl converts https to wss', () => {
  assert.equal(
    lib.buildWsUrl('https://lemniscate.grig-teo.space', 'tok123'),
    'wss://lemniscate.grig-teo.space/api/devices/ws?token=tok123',
  );
});

test('buildWsUrl converts http to ws', () => {
  assert.equal(
    lib.buildWsUrl('http://localhost:3000', 'tok123'),
    'ws://localhost:3000/api/devices/ws?token=tok123',
  );
});

test('buildWsUrl strips trailing slashes', () => {
  assert.equal(
    lib.buildWsUrl('https://x.space/', 't'),
    'wss://x.space/api/devices/ws?token=t',
  );
});

test('buildWsUrl preserves custom ports', () => {
  assert.equal(
    lib.buildWsUrl('https://x.space:8443', 't'),
    'wss://x.space:8443/api/devices/ws?token=t',
  );
});

test('buildWsUrl URL-encodes the token', () => {
  assert.equal(
    lib.buildWsUrl('https://x.space', 'a b+c/d='),
    'wss://x.space/api/devices/ws?token=a%20b%2Bc%2Fd%3D',
  );
});

// --- repo dir naming ------------------------------------------------------------

test('repoDirName is deterministic', () => {
  const url = 'https://github.com/grig/lemniscate.git';
  assert.equal(lib.repoDirName(url), lib.repoDirName(url));
});

test('repoDirName slugifies host and path, strips .git', () => {
  const name = lib.repoDirName('https://github.com/Grig/Lemniscate.git');
  assert.match(name, /^github-com-grig-lemniscate-[0-9a-f]{8}$/);
});

test('repoDirName differs for different repos with the same slug tail', () => {
  assert.notEqual(
    lib.repoDirName('https://github.com/a/app'),
    lib.repoDirName('https://github.com/b/app'),
  );
});

test('repoDirName handles scp-like git URLs', () => {
  const name = lib.repoDirName('git@github.com:grig/lemniscate.git');
  assert.match(name, /^git-github-com-grig-lemniscate-[0-9a-f]{8}$/);
});

test('repoDirFor nests the dir under the repos root', () => {
  const dir = lib.repoDirFor('https://github.com/grig/lemniscate');
  assert.equal(path.dirname(dir), lib.reposRoot());
});

// --- config persistence -----------------------------------------------------------

test('saveConfig/loadConfig round-trips with mode 0600', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lemn-agent-')), 'config.json');
  const config = { server: 'https://x.space', deviceId: 'd1', deviceToken: 'secret', name: 'Mac', platform: 'desktop' };
  lib.saveConfig(config, file);
  assert.deepEqual(lib.loadConfig(file), config);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('loadConfig returns null for missing or invalid files', () => {
  assert.equal(lib.loadConfig('/nonexistent/path.json'), null);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lemn-agent-')), 'bad.json');
  fs.writeFileSync(file, '{"deviceToken": 42}');
  assert.equal(lib.loadConfig(file), null);
});

// --- run strategy detection ---------------------------------------------------------

test('detectRunStrategy prefers an explicit composePath', () => {
  const strategy = lib.detectRunStrategy(['docker-compose.yml', 'Dockerfile'], 'docker/compose.yml');
  assert.deepEqual(strategy, { kind: 'compose', file: 'docker/compose.yml' });
});

test('detectRunStrategy follows compose-file priority order', () => {
  const files = ['compose.yml', 'docker-compose.yml', 'Dockerfile'];
  assert.deepEqual(lib.detectRunStrategy(files), { kind: 'compose', file: 'docker-compose.yml' });
  assert.deepEqual(lib.detectRunStrategy(['compose.yaml']), { kind: 'compose', file: 'compose.yaml' });
});

test('detectRunStrategy falls back to a root Dockerfile', () => {
  assert.deepEqual(lib.detectRunStrategy(['Dockerfile', 'README.md']), {
    kind: 'dockerfile',
    file: 'Dockerfile',
  });
});

test('detectRunStrategy returns null when nothing runnable exists', () => {
  assert.equal(lib.detectRunStrategy(['README.md', 'src']), null);
});

// --- message builders -----------------------------------------------------------------

test('helloMessage and heartbeatMessage shapes', () => {
  assert.deepEqual(lib.heartbeatMessage(), { type: 'heartbeat' });
  assert.deepEqual(lib.helloMessage({ os: 'darwin' }), { type: 'hello', meta: { os: 'darwin' } });
});

test('commandResultMessage includes result only when defined', () => {
  assert.deepEqual(lib.commandResultMessage('c1', 'running'), {
    type: 'command_result',
    id: 'c1',
    status: 'running',
  });
  assert.deepEqual(lib.commandResultMessage('c1', 'done', { url: 'http://127.0.0.1:3000' }), {
    type: 'command_result',
    id: 'c1',
    status: 'done',
    result: { url: 'http://127.0.0.1:3000' },
  });
});

// --- parseServerMessage -----------------------------------------------------------------

test('parseServerMessage parses welcome', () => {
  assert.deepEqual(lib.parseServerMessage('{"type":"welcome","deviceId":"d1"}'), {
    kind: 'welcome',
    deviceId: 'd1',
  });
});

test('parseServerMessage parses run_web commands', () => {
  const raw = JSON.stringify({
    id: 'cmd1',
    type: 'run_web',
    payload: { repoUrl: 'https://github.com/a/b', branch: 'main', port: 3000 },
  });
  const message = lib.parseServerMessage(raw);
  assert.equal(message.kind, 'command');
  assert.equal(message.id, 'cmd1');
  assert.equal(message.payload.port, 3000);
});

test('parseServerMessage returns null for garbage and unknown types', () => {
  assert.equal(lib.parseServerMessage('not json'), null);
  assert.equal(lib.parseServerMessage('{"type":"mystery"}'), null);
  assert.equal(lib.parseServerMessage('{}'), null);
  assert.equal(lib.parseServerMessage(Buffer.from('{"type":"mystery"}')), null);
});

// --- misc helpers -------------------------------------------------------------------------

test('browserOpenCommand picks the platform opener', () => {
  assert.deepEqual(lib.browserOpenCommand('http://x', 'darwin'), { command: 'open', args: ['http://x'] });
  assert.deepEqual(lib.browserOpenCommand('http://x', 'win32'), {
    command: 'cmd',
    args: ['/c', 'start', '', 'http://x'],
  });
  assert.deepEqual(lib.browserOpenCommand('http://x', 'linux'), { command: 'xdg-open', args: ['http://x'] });
});

test('tailLog caps long logs at the tail', () => {
  const text = 'x'.repeat(3000);
  assert.equal(lib.tailLog(text).length, 2048);
  assert.equal(lib.tailLog('short'), 'short');
});

test('collectMeta reports os, arch, hostname and agent version', () => {
  const meta = lib.collectMeta({ dockerAvailable: true });
  assert.equal(meta.os, process.platform);
  assert.equal(meta.arch, process.arch);
  assert.equal(meta.hostname, os.hostname());
  assert.equal(meta.dockerAvailable, true);
  assert.equal(typeof meta.agentVersion, 'string');
});

// --- install_apk helpers --------------------------------------------------------

test('apkFileName prefers the app name slug', () => {
  const name = lib.apkFileName('https://x.space/files/v1/app-release.apk?sig=1', 'My Cool App');
  assert.match(name, /^my-cool-app-[0-9a-f]{8}\.apk$/);
});

test('apkFileName falls back to the URL basename, stripping .apk and query', () => {
  const name = lib.apkFileName('https://x.space/files/app-release.apk?sig=1');
  assert.match(name, /^app-release-[0-9a-f]{8}\.apk$/);
});

test('apkFileName falls back to "app" for opaque URLs and is deterministic', () => {
  const url = 'https://x.space/?id=42';
  assert.match(lib.apkFileName(url), /^app-[0-9a-f]{8}\.apk$/);
  assert.equal(lib.apkFileName(url), lib.apkFileName(url));
  assert.notEqual(lib.apkFileName(url), lib.apkFileName('https://x.space/?id=43'));
});

test('apkPathFor nests the file under the apks root', () => {
  const dest = lib.apkPathFor('https://x.space/a.apk', 'demo');
  assert.equal(path.dirname(dest), lib.apksRoot());
  assert.match(dest, /demo-[0-9a-f]{8}\.apk$/);
});

test('isTermux detects android platform or the TERMUX_VERSION env', () => {
  assert.equal(lib.isTermux('android', {}), true);
  assert.equal(lib.isTermux('linux', { TERMUX_VERSION: '0.118' }), true);
  assert.equal(lib.isTermux('darwin', {}), false);
});

test('installIntentCommand builds the am start VIEW intent for the APK', () => {
  assert.deepEqual(lib.installIntentCommand('/data/local/tmp/app.apk'), {
    command: 'am',
    args: [
      'start',
      '-a', 'android.intent.action.VIEW',
      '-d', 'file:///data/local/tmp/app.apk',
      '-t', 'application/vnd.android.package-archive',
    ],
  });
});

test('parseServerMessage parses install_apk commands', () => {
  const raw = JSON.stringify({
    id: 'cmd2',
    type: 'install_apk',
    payload: { apkUrl: 'https://x.space/a.apk', appName: 'Demo' },
  });
  const message = lib.parseServerMessage(raw);
  assert.equal(message.kind, 'command');
  assert.equal(message.commandType, 'install_apk');
  assert.equal(message.payload.apkUrl, 'https://x.space/a.apk');
});

test('APK downloads are capped at 100MB', () => {
  assert.equal(lib.APK_MAX_BYTES, 100 * 1024 * 1024);
});
