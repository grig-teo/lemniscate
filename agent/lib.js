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

export const AGENT_VERSION = '0.3.0';

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
const COMMAND_TYPES = ['run_web', 'install_apk', 'build_android'];

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
