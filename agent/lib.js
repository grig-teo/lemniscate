/**
 * Pure-ish helpers for the Lemniscate device agent: config persistence,
 * repo-dir naming, WS URL building, message shapes, run-strategy detection.
 * No I/O here except config load/save — everything else is a pure function
 * so it can be unit-tested with node:test.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AGENT_VERSION = '0.4.1';

/** install_apk downloads are refused beyond this size. */
export const APK_MAX_BYTES = 100 * 1024 * 1024;

/** Default compose file names, in priority order. */
export const COMPOSE_CANDIDATES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

// --- Config -----------------------------------------------------------------

export function configPath() {
  return path.join(os.homedir(), '.lemniscate-agent.json');
}

/** Load persisted device credentials; null when missing or unreadable. */
export function loadConfig(file = configPath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data.deviceToken !== 'string' || typeof data.server !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/** Persist device credentials owner-only (the token is a secret). */
export function saveConfig(config, file = configPath()) {
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// --- Repo dir naming --------------------------------------------------------

/** Slug for a repo URL: host+path, lowercase, alnum-and-dash only. */
export function slugifyRepoUrl(repoUrl) {
  let text = repoUrl;
  try {
    const url = new URL(repoUrl);
    text = url.hostname + url.pathname;
  } catch {
    // scp-like git@host:path URLs — slugify the raw string as-is.
  }
  const slug = text
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'repo';
}

/** Short stable hash distinguishing repos whose slugs collide. */
export function shortHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/** Directory name under the repos root for one repo URL. Deterministic. */
export function repoDirName(repoUrl) {
  return `${slugifyRepoUrl(repoUrl)}-${shortHash(repoUrl)}`;
}

export function reposRoot() {
  return path.join(os.homedir(), '.lemniscate-agent', 'repos');
}

export function repoDirFor(repoUrl) {
  return path.join(reposRoot(), repoDirName(repoUrl));
}

// --- install_apk helpers ------------------------------------------------------

export function apksRoot() {
  return path.join(os.homedir(), '.lemniscate-agent', 'apks');
}

/** Slug base for a downloaded APK: the app name when given, else the URL basename. */
function apkSlugBase(apkUrl, appName) {
  let text = appName ?? '';
  if (!text) {
    try {
      text = path.posix.basename(new URL(apkUrl).pathname);
    } catch {
      text = '';
    }
  }
  return text
    .replace(/\.apk$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deterministic APK file name: slug plus a short hash of the URL. */
export function apkFileName(apkUrl, appName) {
  return `${apkSlugBase(apkUrl, appName) || 'app'}-${shortHash(apkUrl)}.apk`;
}

export function apkPathFor(apkUrl, appName) {
  return path.join(apksRoot(), apkFileName(apkUrl, appName));
}

/** Auth header for APK downloads from OUR server (artifacts need a device
 * token); empty object for external URLs so no token leaks to third parties. */
export function downloadHeaders(serverOrigin, url, deviceToken) {
  try {
    if (deviceToken && new URL(url).origin === new URL(serverOrigin).origin) {
      return { authorization: `Device ${deviceToken}` };
    }
  } catch {
    // unparseable URL — fetch will fail on its own
  }
  return {};
}

/** True on Termux (Android userland): node platform 'android' or TERMUX_VERSION set. */
export function isTermux(platform = process.platform, env = process.env) {
  return platform === 'android' || typeof env.TERMUX_VERSION === 'string';
}

/** `am start` VIEW intent that opens the system package installer for an APK. */
export function installIntentCommand(apkPath) {
  return {
    command: 'am',
    args: [
      'start',
      '-a', 'android.intent.action.VIEW',
      '-d', `file://${apkPath}`,
      '-t', 'application/vnd.android.package-archive',
    ],
  };
}

// --- adb helpers ----------------------------------------------------------------

/** Candidate adb binaries: PATH first, then the standard SDK locations. */
export function adbCandidates(env = process.env, home = os.homedir()) {
  const candidates = ['adb'];
  if (env.ANDROID_HOME) candidates.push(path.join(env.ANDROID_HOME, 'platform-tools', 'adb'));
  candidates.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
  return candidates;
}

/**
 * Devices in state `device` from `adb devices` / `adb devices -l` output (the
 * header line is skipped, offline/unauthorized entries excluded). Each entry
 * is {serial, model?, transport} — wifi serials are host:5555 or mDNS
 * `._adb-tls-connect` names, everything else is usb.
 */
export function parseAdbDevices(output) {
  const devices = [];
  for (const line of output.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2 || fields[1] !== 'device') continue;
    const device = { serial: fields[0], transport: adbTransport(fields[0]) };
    const model = fields.find((field) => field.startsWith('model:'));
    if (model) device.model = model.slice('model:'.length);
    devices.push(device);
  }
  return devices;
}

function adbTransport(serial) {
  return serial.includes(':5555') || serial.includes('._adb-tls-connect') ? 'wifi' : 'usb';
}

// --- capabilities probes ---------------------------------------------------------

/** capabilities envelope reporting the device's live run targets. */
export function capabilitiesMessage(capabilities) {
  return { type: 'capabilities', capabilities };
}

/**
 * Available simulators ({name, runtime, state}) from
 * `xcrun simctl list devices -j available` JSON.
 */
export function parseSimctlDevices(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const simulators = [];
  for (const [runtime, devices] of Object.entries(data.devices ?? {})) {
    for (const device of devices) {
      if (device.isAvailable === false || !device.name) continue;
      simulators.push({ name: device.name, runtime: simRuntimeLabel(runtime), state: device.state });
    }
  }
  return simulators;
}

/** 'com.apple.CoreSimulator.SimRuntime.iOS-17-5' → 'iOS 17.5'. */
function simRuntimeLabel(runtime) {
  return runtime
    .replace('com.apple.CoreSimulator.SimRuntime.', '')
    .replace(/-/g, '.')
    .replace(/^([A-Za-z]+)\./, '$1 ');
}

/** AVD names ({name}) from `emulator -list-avds` output; noise lines skipped. */
export function parseEmulatorList(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(INFO|WARNING|ERROR)\b/.test(line))
    .map((name) => ({ name }));
}

/**
 * Physical iOS devices ({name, udid, available}) from
 * `xcrun devicectl list devices --json-output` JSON.
 */
export function parseDevicectlDevices(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const devices = data?.result?.devices;
  if (!Array.isArray(devices)) return [];
  return devices
    .filter((entry) => isPhysicalIosDevice(entry))
    .map((entry) => ({
      name: entry.hardwareProperties.marketingName ?? entry.deviceProperties?.name ?? 'iOS device',
      udid: entry.hardwareProperties.udid ?? entry.identifier,
      available: entry.connectionProperties?.tunnelState !== 'unavailable',
    }))
    .filter((device) => Boolean(device.udid));
}

function isPhysicalIosDevice(entry) {
  const hardware = entry?.hardwareProperties;
  return hardware?.platform === 'iOS' && hardware?.reality === 'physical';
}

/** Candidate emulator binaries: PATH first, then the standard SDK locations. */
export function emulatorCandidates(env = process.env, home = os.homedir()) {
  const candidates = ['emulator'];
  if (env.ANDROID_HOME) candidates.push(path.join(env.ANDROID_HOME, 'emulator', 'emulator'));
  candidates.push(path.join(home, 'Library', 'Android', 'sdk', 'emulator', 'emulator'));
  return candidates;
}

// --- build_android helpers ----------------------------------------------------

/** docker run args for a gradle build inside the android build box image. */
export function gradleDockerArgs({ repoDir, image, gradleModule, gradleTask }) {
  return [
    'run', '--rm',
    '-v', `${repoDir}:/project`,
    '-w', '/project',
    image,
    'sh', '-c', `./gradlew --no-daemon ${gradleModule}:${gradleTask}`,
  ];
}

/** Newest APK by mtime among candidates ({path, mtimeMs}), null when empty. */
export function pickNewestApk(candidates) {
  let newest = null;
  for (const candidate of candidates) {
    if (!newest || candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }
  return newest?.path ?? null;
}

/** All *.apk files under <repoDir>/<module>/build/outputs/apk, with mtimes. */
export function findApkCandidates(repoDir, gradleModule) {
  const root = path.join(repoDir, gradleModule, 'build', 'outputs', 'apk');
  const candidates = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.apk')) {
        candidates.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return candidates;
}

/** Upload endpoint for a built APK on the Lemniscate server. */
export function artifactUploadUrl(uploadBaseUrl, filename) {
  const base = uploadBaseUrl.replace(/\/+$/, '');
  return `${base}/api/devices/artifacts?filename=${encodeURIComponent(filename)}`;
}

// --- run_desktop helpers ------------------------------------------------------

/** package.json scripts tried as the desktop entry point, in priority order. */
export const DESKTOP_SCRIPT_CANDIDATES = ['tauri', 'electron', 'dev', 'start'];

/**
 * Which npm script to launch for a desktop repo. A requested script wins but
 * must exist in package.json; otherwise the first candidate present is used.
 * Null when nothing usable was found (caller fails with a clear message).
 */
export function pickDesktopScript(scripts, requested) {
  if (requested) return requested in scripts ? requested : null;
  for (const candidate of DESKTOP_SCRIPT_CANDIDATES) {
    if (candidate in scripts) return candidate;
  }
  return null;
}

/** Tauri scripts need a Rust toolchain on the device (cargo build). */
export function isTauriScript(scriptName) {
  return scriptName.includes('tauri');
}

// --- run_ios helpers ------------------------------------------------------------

/**
 * Directory holding an xcodegen project.yml, ios/ first then the repo root;
 * null when the repo has no xcodegen setup.
 */
export function xcodegenDir(projectDir) {
  for (const dir of ['ios', '.']) {
    if (fs.existsSync(path.join(projectDir, dir, 'project.yml'))) {
      return path.join(projectDir, dir);
    }
  }
  return null;
}

/**
 * Locate the Xcode project to build: ios/ first, then the repo root, then any
 * other one-level-deep directory (alphabetical) for monorepo layouts; within a
 * directory a .xcworkspace wins over a .xcodeproj. Returns
 * {flag, path, name} or null.
 */
export function findXcodeProject(projectDir) {
  const others = fs.readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'ios' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const dir of ['ios', '.', ...others]) {
    const abs = path.join(projectDir, dir);
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch {
      continue;
    }
    const workspace = names.find((name) => name.endsWith('.xcworkspace'));
    if (workspace) {
      return { flag: '-workspace', path: path.join(abs, workspace), name: workspace.replace(/\.xcworkspace$/, '') };
    }
    const project = names.find((name) => name.endsWith('.xcodeproj'));
    if (project) {
      return { flag: '-project', path: path.join(abs, project), name: project.replace(/\.xcodeproj$/, '') };
    }
  }
  return null;
}

/** All UDIDs known to simctl, from `xcrun simctl list devices -j` JSON. */
function simctlUdids(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  return Object.values(data.devices ?? {}).flat().map((device) => device.udid).filter(Boolean);
}

/** True when the UDID belongs to a simulator (not a physical device). */
export function isSimulatorUdid(jsonText, udid) {
  return simctlUdids(jsonText).includes(udid);
}

/** First booted simulator UDID from `xcrun simctl list devices -j` JSON. */
export function parseBootedSimulatorUdid(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  for (const devices of Object.values(data.devices ?? {})) {
    for (const device of devices) {
      if (device.state === 'Booted' && device.udid) return device.udid;
    }
  }
  return null;
}

/** First available iPhone simulator ({udid, name}) from simctl list JSON. */
export function parseAvailableIphone(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  for (const [runtime, devices] of Object.entries(data.devices ?? {})) {
    if (!runtime.includes('iOS')) continue;
    for (const device of devices) {
      if (device.isAvailable !== false && device.udid && /iPhone/.test(device.name ?? '')) {
        return { udid: device.udid, name: device.name };
      }
    }
  }
  return null;
}

/**
 * First .app under a derived-data Products dir (e.g. Debug-iphonesimulator or
 * Debug-iphoneos), null when the build produced none.
 */
export function findBuiltApp(productsRoot) {
  if (!fs.existsSync(productsRoot)) return null;
  for (const dir of fs.readdirSync(productsRoot).sort()) {
    if (!/-(iphonesimulator|iphoneos)$/.test(dir)) continue;
    const full = path.join(productsRoot, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const app = fs.readdirSync(full).find((name) => name.endsWith('.app'));
    if (app) return path.join(full, app);
  }
  return null;
}

/** xcodebuild invocation for a simulator or device destination build. */
export function xcodebuildArgs({ flag, projectPath, scheme, destination, derivedDataPath }) {
  return [
    flag, projectPath,
    '-scheme', scheme,
    '-destination', destination,
    '-derivedDataPath', derivedDataPath,
    'build',
  ];
}

// --- URLs / messages ----------------------------------------------------------

/** http(s) server base URL → ws(s) device-tunnel URL for a device token. */
export function buildWsUrl(server, token) {
  const url = new URL(server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/api/devices/ws';
  url.search = `?token=${encodeURIComponent(token)}`;
  url.hash = '';
  return url.toString();
}

export function helloMessage(meta) {
  return { type: 'hello', meta };
}

export function heartbeatMessage() {
  return { type: 'heartbeat' };
}

/** command_result envelope; result is included only when defined. */
export function commandResultMessage(id, status, result) {
  const message = { type: 'command_result', id, status };
  if (result !== undefined) message.result = result;
  return message;
}

/**
 * Parse a raw server frame. Returns
 * {kind:'welcome', deviceId} | {kind:'command', id, commandType, payload} | null.
 */
const COMMAND_TYPES = ['run_web', 'install_apk', 'build_android', 'run_desktop', 'run_ios'];

export function parseServerMessage(raw) {
  let message;
  try {
    message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!message || typeof message.type !== 'string') return null;
  if (message.type === 'welcome') return { kind: 'welcome', deviceId: message.deviceId };
  if (COMMAND_TYPES.includes(message.type) && message.payload) {
    return { kind: 'command', id: message.id, commandType: message.type, payload: message.payload };
  }
  return null;
}

// --- run_web strategy ---------------------------------------------------------

/**
 * Pick how to run a repo from its root file listing.
 * composePath (from the command) wins when given; then default compose file
 * names in priority order; then a root Dockerfile; else null.
 */
export function detectRunStrategy(fileNames, composePath) {
  if (composePath) return { kind: 'compose', file: composePath };
  for (const candidate of COMPOSE_CANDIDATES) {
    if (fileNames.includes(candidate)) return { kind: 'compose', file: candidate };
  }
  if (fileNames.includes('Dockerfile')) return { kind: 'dockerfile', file: 'Dockerfile' };
  return null;
}

/** Platform-specific command to open a URL in the user's browser. */
export function browserOpenCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

/** Tail of a build/run log, capped so command results stay small. */
export function tailLog(text, maxBytes = 2048) {
  if (text.length <= maxBytes) return text;
  return text.slice(text.length - maxBytes);
}

/** meta object sent in the claim body and the WS hello. */
export function collectMeta({ agentVersion = AGENT_VERSION, dockerAvailable = false } = {}) {
  return {
    os: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    agentVersion,
    dockerAvailable,
  };
}
