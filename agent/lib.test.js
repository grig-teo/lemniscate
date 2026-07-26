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

// --- build_android helpers -----------------------------------------------------

test('gradleDockerArgs builds the docker run invocation', () => {
  assert.deepEqual(
    lib.gradleDockerArgs({
      repoDir: '/repos/app',
      image: 'mingc/android-build-box:1.29.0',
      gradleModule: 'app',
      gradleTask: 'assembleDebug',
    }),
    [
      'run', '--rm',
      '-v', '/repos/app:/project',
      '-w', '/project',
      'mingc/android-build-box:1.29.0',
      'sh', '-c', './gradlew --no-daemon app:assembleDebug',
    ],
  );
});

test('pickNewestApk picks the most recent candidate, null when empty', () => {
  const candidates = [
    { path: '/a/old.apk', mtimeMs: 100 },
    { path: '/a/new.apk', mtimeMs: 300 },
    { path: '/a/mid.apk', mtimeMs: 200 },
  ];
  assert.equal(lib.pickNewestApk(candidates), '/a/new.apk');
  assert.equal(lib.pickNewestApk([]), null);
});

test('findApkCandidates walks the module apk output tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-glob-'));
  const nested = path.join(root, 'app', 'build', 'outputs', 'apk', 'debug');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'app-debug.apk'), 'x');
  fs.writeFileSync(path.join(nested, 'notes.txt'), 'x');
  const candidates = lib.findApkCandidates(root, 'app');
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].path, /app-debug\.apk$/);
  assert.ok(candidates[0].mtimeMs > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findApkCandidates returns [] when the output dir does not exist', () => {
  assert.deepEqual(lib.findApkCandidates(os.tmpdir(), 'no-such-module'), []);
});

test('artifactUploadUrl appends the encoded filename query', () => {
  assert.equal(
    lib.artifactUploadUrl('https://api.x/', 'my app.apk'),
    'https://api.x/api/devices/artifacts?filename=my%20app.apk',
  );
});

test('parseServerMessage parses build_android commands', () => {
  const raw = '{"type":"build_android","id":"c1","payload":{"repoUrl":"https://x","branch":"main"}}';
  assert.deepEqual(lib.parseServerMessage(raw), {
    kind: 'command',
    id: 'c1',
    commandType: 'build_android',
    payload: { repoUrl: 'https://x', branch: 'main' },
  });
});

test('downloadHeaders attaches the device token for same-origin downloads', () => {
  assert.deepEqual(
    lib.downloadHeaders('https://lemniscate.grig-teo.space', 'https://lemniscate.grig-teo.space/api/devices/artifacts/d/u-a.apk', 'tok'),
    { authorization: 'Device tok' },
  );
});

test('downloadHeaders never leaks the token to third-party origins', () => {
  assert.deepEqual(lib.downloadHeaders('https://lemniscate.grig-teo.space', 'https://evil.example.com/a.apk', 'tok'), {});
});

test('downloadHeaders returns empty headers without a token or on unparseable URLs', () => {
  assert.deepEqual(lib.downloadHeaders('https://x.space', 'https://x.space/a.apk', null), {});
  assert.deepEqual(lib.downloadHeaders('not a url', 'also not', 'tok'), {});
});

// --- run_desktop helpers --------------------------------------------------------

test('parseServerMessage parses run_desktop commands', () => {
  const raw = '{"type":"run_desktop","id":"c1","payload":{"repoUrl":"https://x","branch":"main","startScript":"electron"}}';
  assert.deepEqual(lib.parseServerMessage(raw), {
    kind: 'command',
    id: 'c1',
    commandType: 'run_desktop',
    payload: { repoUrl: 'https://x', branch: 'main', startScript: 'electron' },
  });
});

test('pickDesktopScript prefers candidates in priority order', () => {
  const scripts = { start: 'x', dev: 'x', electron: 'x', tauri: 'x' };
  assert.equal(lib.pickDesktopScript(scripts), 'tauri');
  assert.equal(lib.pickDesktopScript({ start: 'x', dev: 'x', electron: 'x' }), 'electron');
  assert.equal(lib.pickDesktopScript({ start: 'x', dev: 'x' }), 'dev');
  assert.equal(lib.pickDesktopScript({ start: 'x' }), 'start');
});

test('pickDesktopScript honors the requested script when it exists', () => {
  const scripts = { tauri: 'x', 'dev:app': 'x' };
  assert.equal(lib.pickDesktopScript(scripts, 'dev:app'), 'dev:app');
});

test('pickDesktopScript returns null for a missing requested script', () => {
  assert.equal(lib.pickDesktopScript({ start: 'x' }, 'electron'), null);
});

test('pickDesktopScript returns null when no candidate exists', () => {
  assert.equal(lib.pickDesktopScript({ test: 'x', build: 'x' }), null);
  assert.equal(lib.pickDesktopScript({}), null);
});

test('isTauriScript matches tauri-related script names only', () => {
  assert.equal(lib.isTauriScript('tauri'), true);
  assert.equal(lib.isTauriScript('tauri:dev'), true);
  assert.equal(lib.isTauriScript('dev:tauri'), true);
  assert.equal(lib.isTauriScript('electron'), false);
  assert.equal(lib.isTauriScript('start'), false);
});

// --- adb helpers ----------------------------------------------------------------

test('adbCandidates covers PATH and the standard SDK locations', () => {
  const candidates = lib.adbCandidates({ ANDROID_HOME: '/sdk' }, '/home/u');
  assert.equal(candidates[0], 'adb');
  assert.ok(candidates.includes(path.join('/sdk', 'platform-tools', 'adb')));
  assert.ok(candidates.includes(path.join('/home/u', 'Library', 'Android', 'sdk', 'platform-tools', 'adb')));
});

test('adbCandidates skips ANDROID_HOME when unset', () => {
  const candidates = lib.adbCandidates({}, '/home/u');
  assert.equal(candidates.length, 2);
});

test('parseAdbDevices returns online devices only, with model and transport', () => {
  const output = [
    'List of devices attached',
    'emulator-5554\tdevice',
    '0a1b2c3d\toffline',
    '9x8y7z\tunauthorized',
    '',
  ].join('\n');
  assert.deepEqual(lib.parseAdbDevices(output), [{ serial: 'emulator-5554', transport: 'usb' }]);
});

test('parseAdbDevices parses adb devices -l model and wifi serials', () => {
  const output = [
    'List of devices attached',
    '0a1b2c3d               device usb:1-2 product:a model:Pixel_8 device:b transport_id:1',
    '192.168.1.5:5555       device product:x model:Pixel_7 device:y transport_id:2',
    'adb-abc123-XYZ._adb-tls-connect._tcp. device product:x model:Pixel_6 device:y transport_id:3',
    '',
  ].join('\n');
  assert.deepEqual(lib.parseAdbDevices(output), [
    { serial: '0a1b2c3d', model: 'Pixel_8', transport: 'usb' },
    { serial: '192.168.1.5:5555', model: 'Pixel_7', transport: 'wifi' },
    { serial: 'adb-abc123-XYZ._adb-tls-connect._tcp.', model: 'Pixel_6', transport: 'wifi' },
  ]);
});

test('parseAdbDevices returns [] when nothing is attached', () => {
  assert.deepEqual(lib.parseAdbDevices('List of devices attached\n\n'), []);
});

test('pickAdbDevice returns the requested serial when attached', () => {
  const devices = [
    { serial: '0a1b2c3d', transport: 'usb' },
    { serial: 'emulator-5554', transport: 'usb' },
  ];
  assert.equal(lib.pickAdbDevice(devices, 'emulator-5554'), 'emulator-5554');
});

test('pickAdbDevice defaults to the first device without a requested serial', () => {
  const devices = [
    { serial: '0a1b2c3d', transport: 'usb' },
    { serial: 'emulator-5554', transport: 'usb' },
  ];
  assert.equal(lib.pickAdbDevice(devices, null), '0a1b2c3d');
  assert.equal(lib.pickAdbDevice(devices, undefined), '0a1b2c3d');
});

test('pickAdbDevice returns null when nothing is attached and no serial requested', () => {
  assert.equal(lib.pickAdbDevice([], null), null);
  assert.equal(lib.pickAdbDevice([], undefined), null);
});

test('pickAdbDevice throws for an unknown serial, listing the available ones', () => {
  const devices = [{ serial: '0a1b2c3d', transport: 'usb' }, { serial: 'emulator-5554', transport: 'usb' }];
  assert.throws(() => lib.pickAdbDevice(devices, 'deadbeef'), (error) => {
    assert.ok(error.message.includes('deadbeef'));
    assert.ok(error.message.includes('0a1b2c3d'));
    assert.ok(error.message.includes('emulator-5554'));
    return true;
  });
});

test('pickAdbDevice reports "none" available for an unknown serial on an empty list', () => {
  assert.throws(() => lib.pickAdbDevice([], 'deadbeef'), /adb device "deadbeef" not found \(available: none\)/);
});

// --- capabilities probes ---------------------------------------------------------

test('capabilitiesMessage wraps the report in the capabilities envelope', () => {
  const capabilities = { dockerAvailable: true, androidDevices: [], iosDevices: [], simulators: [], emulators: [] };
  assert.deepEqual(lib.capabilitiesMessage(capabilities), { type: 'capabilities', capabilities });
});

test('parseSimctlDevices lists available simulators with udid, runtime and state', () => {
  const simulators = lib.parseSimctlDevices(SIMCTL_JSON);
  assert.deepEqual(simulators, [
    { name: 'iPhone 15', udid: 'SIM-BOOTED', runtime: 'iOS 17.5', state: 'Booted' },
    { name: 'iPhone SE', udid: 'SIM-SHUTDOWN', runtime: 'iOS 17.5', state: 'Shutdown' },
    { name: 'Apple Watch', udid: 'WATCH-1', runtime: 'watchOS 10.5', state: 'Shutdown' },
  ]);
});

test('parseSimctlDevices returns [] for garbage or empty JSON', () => {
  assert.deepEqual(lib.parseSimctlDevices('garbage'), []);
  assert.deepEqual(lib.parseSimctlDevices('{"devices":{}}'), []);
});

test('parseEmulatorList returns AVD names, skipping noise lines', () => {
  const output = 'INFO    | Storing crashdata\nPixel_API_35\n\nMedium_Phone_API_36\n';
  assert.deepEqual(lib.parseEmulatorList(output), [
    { name: 'Pixel_API_35' },
    { name: 'Medium_Phone_API_36' },
  ]);
  assert.deepEqual(lib.parseEmulatorList(''), []);
});

const DEVICECTL_JSON = JSON.stringify({
  result: {
    devices: [
      {
        identifier: '73BBE0E0-0142',
        hardwareProperties: {
          platform: 'iOS',
          reality: 'physical',
          marketingName: 'iPhone 14 Pro Max',
          udid: '00008120-00025C643A70201E',
        },
        deviceProperties: { name: 'iPhone' },
        connectionProperties: { tunnelState: 'disconnected', pairingState: 'paired' },
      },
      {
        identifier: 'D3FAB70D-1D5C',
        hardwareProperties: { platform: 'iOS', reality: 'physical', marketingName: 'iPhone 13', udid: 'UDID-2' },
        connectionProperties: { tunnelState: 'unavailable' },
      },
      {
        identifier: 'SIM-1',
        hardwareProperties: { platform: 'iOS', reality: 'virtual', marketingName: 'iPhone 17' },
        connectionProperties: { tunnelState: 'connected' },
      },
    ],
  },
});

test('parseDevicectlDevices lists physical iOS devices with availability', () => {
  assert.deepEqual(lib.parseDevicectlDevices(DEVICECTL_JSON), [
    { name: 'iPhone 14 Pro Max', udid: '00008120-00025C643A70201E', available: true },
    { name: 'iPhone 13', udid: 'UDID-2', available: false },
  ]);
});

test('parseDevicectlDevices returns [] for garbage or missing result', () => {
  assert.deepEqual(lib.parseDevicectlDevices('garbage'), []);
  assert.deepEqual(lib.parseDevicectlDevices('{"result":{}}'), []);
});

// --- run_ios helpers --------------------------------------------------------------

const SIMCTL_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
      { udid: 'SIM-BOOTED', name: 'iPhone 15', state: 'Booted', isAvailable: true },
      { udid: 'SIM-SHUTDOWN', name: 'iPhone SE', state: 'Shutdown', isAvailable: true },
      { udid: 'SIM-UNAVAILABLE', name: 'iPhone 14', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-10-5': [
      { udid: 'WATCH-1', name: 'Apple Watch', state: 'Shutdown', isAvailable: true },
    ],
  },
});

test('parseServerMessage parses run_ios commands', () => {
  const raw = '{"type":"run_ios","id":"c1","payload":{"repoUrl":"https://x","branch":"main","scheme":"App"}}';
  assert.deepEqual(lib.parseServerMessage(raw), {
    kind: 'command',
    id: 'c1',
    commandType: 'run_ios',
    payload: { repoUrl: 'https://x', branch: 'main', scheme: 'App' },
  });
});

test('parseBootedSimulatorUdid returns the first booted device, null otherwise', () => {
  assert.equal(lib.parseBootedSimulatorUdid(SIMCTL_JSON), 'SIM-BOOTED');
  assert.equal(lib.parseBootedSimulatorUdid('{"devices":{}}'), null);
  assert.equal(lib.parseBootedSimulatorUdid('garbage'), null);
});

test('parseAvailableIphone skips unavailable devices and non-iOS runtimes', () => {
  assert.deepEqual(lib.parseAvailableIphone(SIMCTL_JSON), { udid: 'SIM-BOOTED', name: 'iPhone 15' });
  assert.equal(lib.parseAvailableIphone('{"devices":{}}'), null);
});

test('isSimulatorUdid distinguishes simulators from physical devices', () => {
  assert.equal(lib.isSimulatorUdid(SIMCTL_JSON, 'SIM-SHUTDOWN'), true);
  assert.equal(lib.isSimulatorUdid(SIMCTL_JSON, '00008101-PHYSICAL'), false);
});

test('xcodegenDir prefers ios/project.yml over the repo root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcodegen-'));
  fs.writeFileSync(path.join(root, 'project.yml'), 'x');
  assert.equal(lib.xcodegenDir(root), root);
  fs.mkdirSync(path.join(root, 'ios'));
  fs.writeFileSync(path.join(root, 'ios', 'project.yml'), 'x');
  assert.equal(lib.xcodegenDir(root), path.join(root, 'ios'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('xcodegenDir returns null without a project.yml', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcodegen-'));
  assert.equal(lib.xcodegenDir(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findXcodeProject prefers ios/ and workspaces over projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-'));
  fs.mkdirSync(path.join(root, 'Root.xcodeproj'));
  fs.mkdirSync(path.join(root, 'ios'));
  fs.mkdirSync(path.join(root, 'ios', 'App.xcodeproj'));
  fs.mkdirSync(path.join(root, 'ios', 'App.xcworkspace'));
  assert.deepEqual(lib.findXcodeProject(root), {
    flag: '-workspace',
    path: path.join(root, 'ios', 'App.xcworkspace'),
    name: 'App',
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('findXcodeProject falls back to a root project, null when absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-'));
  fs.mkdirSync(path.join(root, 'App.xcodeproj'));
  assert.deepEqual(lib.findXcodeProject(root), {
    flag: '-project',
    path: path.join(root, 'App.xcodeproj'),
    name: 'App',
  });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-'));
  assert.equal(lib.findXcodeProject(empty), null);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test('findBuiltApp returns the .app from a platform products dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-'));
  const products = path.join(root, 'Debug-iphonesimulator');
  fs.mkdirSync(products, { recursive: true });
  fs.mkdirSync(path.join(products, 'App.app'));
  fs.writeFileSync(path.join(products, 'notes.txt'), 'x');
  assert.equal(lib.findBuiltApp(root), path.join(products, 'App.app'));
  assert.equal(lib.findBuiltApp(path.join(root, 'missing')), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('xcodebuildArgs builds the invocation', () => {
  assert.deepEqual(
    lib.xcodebuildArgs({
      flag: '-project',
      projectPath: '/repos/app/ios/App.xcodeproj',
      scheme: 'App',
      destination: 'platform=iOS Simulator,id=SIM-1',
      derivedDataPath: '/repos/app/dd',
    }),
    [
      '-project', '/repos/app/ios/App.xcodeproj',
      '-scheme', 'App',
      '-destination', 'platform=iOS Simulator,id=SIM-1',
      '-derivedDataPath', '/repos/app/dd',
      'build',
    ],
  );
});

test('dockerCandidates puts PATH docker first, then per-OS fallbacks', () => {
  assert.equal(lib.dockerCandidates('darwin')[0], 'docker');
  assert.ok(lib.dockerCandidates('darwin').includes('/usr/local/bin/docker'));
  assert.ok(lib.dockerCandidates('darwin').includes('/opt/homebrew/bin/docker'));
  assert.ok(lib.dockerCandidates('linux').includes('/usr/bin/docker'));
  assert.ok(lib.dockerCandidates('linux').includes('/snap/bin/docker'));
  assert.ok(lib.dockerCandidates('win32').some((c) => c.includes('Docker\\Docker\\resources')));
  assert.deepEqual(lib.dockerCandidates('freebsd'), ['docker']);
});
