#!/usr/bin/env node
/**
 * Lemniscate device agent CLI.
 *
 * Pairs with a Lemniscate server (one-time, via a 6-char code from the web
 * UI), then keeps an outbound WebSocket tunnel open and executes commands
 * pushed by the server (run_web: clone a repo and run it in local docker).
 *
 * Usage:
 *   node agent/index.js --server URL --pair CODE [--name NAME] [--platform desktop]
 *   node agent/index.js            # reuse saved credentials (~/.lemniscate-agent.json)
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocket } from 'ws';
import * as lib from './lib.js';

const HEARTBEAT_MS = 25_000;
const CAPABILITIES_INTERVAL_MS = 60_000;
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const HTTP_READY_TIMEOUT_MS = 30_000;
const GRADLE_BUILD_TIMEOUT_MS = 30 * 60_000;
const NPM_INSTALL_TIMEOUT_MS = 15 * 60_000;
const DESKTOP_START_GRACE_MS = 20_000;
const XCODE_BUILD_TIMEOUT_MS = 30 * 60_000;

const USAGE = `Lemniscate device agent

Usage:
  lemniscate-agent --server URL --pair CODE [--name NAME] [--platform desktop]
  lemniscate-agent                      # reconnect using saved credentials

Options:
  --server URL   Lemniscate server base URL (or LEMNISCATE_SERVER env var)
  --pair CODE    6-character pairing code from the web UI (one-time)
  --name NAME    Device name shown in the UI (default: hostname)
  --platform P   desktop | android | ios | web (default: desktop)
  --help         Show this help

Config is stored in ~/.lemniscate-agent.json (mode 0600).
`;

// --- CLI args ---------------------------------------------------------------

function parseArgs(argv) {
  const args = { name: os.hostname(), platform: 'desktop' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!['--server', '--pair', '--name', '--platform'].includes(flag) || !argv[i + 1]) {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    args[flag.slice(2)] = argv[i + 1];
    i += 1;
  }
  args.server = args.server ?? process.env.LEMNISCATE_SERVER;
  return args;
}

// --- Shell helpers ----------------------------------------------------------

/** execFile as a promise; never rejects — result carries the failure. */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10 * 60_000, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, error, output: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

/** Run a step, appending its output to the log; throws on failure. */
async function step(log, command, args, options) {
  const result = await run(command, args, options);
  log.text += `$ ${command} ${args.join(' ')}\n${result.output}`;
  if (!result.ok) throw new Error(`${command} ${args[0] ?? ''} failed (exit ${result.error?.code ?? '?'})`);
}

/** First docker binary that answers `docker info`, cached for the process. */
let resolvedDocker = null;

async function findDocker() {
  if (resolvedDocker) return resolvedDocker;
  for (const candidate of lib.dockerCandidates()) {
    const result = await run(candidate, ['info'], { timeout: 5_000 });
    if (result.ok) {
      resolvedDocker = candidate;
      return candidate;
    }
  }
  return null;
}

/** Resolved docker binary or a hard failure for commands that need it. */
async function requireDocker() {
  const docker = await findDocker();
  if (!docker) throw new Error('Docker not found or not running — start Docker on this device');
  return docker;
}

async function dockerAvailable() {
  return (await findDocker()) !== null;
}

// --- capabilities probes (all best-effort: a missing tool → an empty list) -------

async function probeAdbDevices() {
  const adb = await findAdb();
  if (!adb) return [];
  const result = await run(adb, ['devices', '-l'], { timeout: CAPABILITY_PROBE_TIMEOUT_MS });
  return result.ok ? lib.parseAdbDevices(result.output) : [];
}

async function probeEmulators() {
  for (const candidate of lib.emulatorCandidates()) {
    const result = await run(candidate, ['-list-avds'], { timeout: CAPABILITY_PROBE_TIMEOUT_MS });
    if (result.ok) return lib.parseEmulatorList(result.output);
  }
  return [];
}

async function probeSimulators() {
  const result = await run('xcrun', ['simctl', 'list', 'devices', '-j', 'available'], {
    timeout: CAPABILITY_PROBE_TIMEOUT_MS,
  });
  return result.ok ? lib.parseSimctlDevices(result.output) : [];
}

/** devicectl writes its JSON to a file; read it back and clean up. */
async function probeIosDevices() {
  const jsonPath = path.join(os.tmpdir(), `lemniscate-devicectl-${process.pid}.json`);
  const result = await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', jsonPath], {
    timeout: CAPABILITY_PROBE_TIMEOUT_MS,
  });
  const json = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, 'utf8') : '';
  await fs.promises.rm(jsonPath, { force: true });
  return result.ok ? lib.parseDevicectlDevices(json) : [];
}

/** Live run-target report for the capabilities frame. */
async function collectCapabilities() {
  const [docker, androidDevices, iosDevices, simulators, emulators] = await Promise.all([
    dockerAvailable(),
    probeAdbDevices(),
    probeIosDevices(),
    probeSimulators(),
    probeEmulators(),
  ]);
  return { dockerAvailable: docker, androidDevices, iosDevices, simulators, emulators };
}

// --- Pairing ----------------------------------------------------------------

async function claimPairingCode(server, code, name, platform, meta) {
  const response = await fetch(`${server.replace(/\/+$/, '')}/api/devices/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, platform, meta }),
  });
  if (response.status === 404) throw new Error('Pairing code not recognized — generate a new one in the web UI.');
  if (response.status === 401) throw new Error('Pairing code expired — generate a new one in the web UI.');
  if (!response.ok) throw new Error(`Claim failed (HTTP ${response.status}): ${await response.text()}`);
  return response.json();
}

async function pair(args, meta) {
  if (!args.server) throw new Error('--server URL (or LEMNISCATE_SERVER) is required for pairing.');
  const { deviceId, deviceToken } = await claimPairingCode(
    args.server, args.pair, args.name, args.platform, meta,
  );
  const config = { server: args.server, deviceId, deviceToken, name: args.name, platform: args.platform };
  lib.saveConfig(config);
  console.log(`Paired as "${config.name}" (device ${deviceId}); credentials saved to ${lib.configPath()}`);
  return config;
}

// --- run_web execution --------------------------------------------------------

async function ensureRepo(log, repoUrl, branch) {
  const projectDir = lib.repoDirFor(repoUrl);
  if (fs.existsSync(path.join(projectDir, '.git'))) {
    await step(log, 'git', ['-C', projectDir, 'fetch', '--depth', '1', 'origin', branch]);
    await step(log, 'git', ['-C', projectDir, 'reset', '--hard', 'FETCH_HEAD']);
    return projectDir;
  }
  fs.mkdirSync(lib.reposRoot(), { recursive: true });
  await step(log, 'git', ['clone', '--depth', '1', '--branch', branch, repoUrl, projectDir]);
  return projectDir;
}

async function runWithCompose(log, projectDir, composeFile) {
  const docker = await requireDocker();
  await step(log, docker, ['compose', '-f', composeFile, 'up', '-d', '--build'], { cwd: projectDir });
}

async function runWithDockerfile(log, projectDir, port) {
  const docker = await requireDocker();
  const tag = `lemniscate-${path.basename(projectDir)}`.slice(0, 60);
  await step(log, docker, ['build', '-t', tag, '.'], { cwd: projectDir });
  await run(docker, ['rm', '-f', tag]); // best-effort replace of a previous run
  await step(log, docker, ['run', '-d', '--name', tag, '-p', `${port}:${port}`, tag]);
}

/** Poll until the app answers HTTP (any status counts) or the timeout hits. */
async function waitForHttp(url, timeoutMs = HTTP_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(3_000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return false;
}

async function openBrowser(url) {
  const { command, args } = lib.browserOpenCommand(url);
  await run(command, args, { timeout: 5_000 }); // best-effort — failure isn't fatal
}

async function executeRunWeb(send, config, { id, payload }) {
  const log = { text: '' };
  const url = `http://127.0.0.1:${payload.port}`;
  send(lib.commandResultMessage(id, 'running'));
  try {
    const projectDir = await ensureRepo(log, payload.repoUrl, payload.branch);
    const strategy = lib.detectRunStrategy(fs.readdirSync(projectDir), payload.composePath);
    if (!strategy) throw new Error('No compose file or Dockerfile found at repo root');
    if (strategy.kind === 'compose') await runWithCompose(log, projectDir, strategy.file);
    else await runWithDockerfile(log, projectDir, payload.port);
    if (!(await waitForHttp(url))) throw new Error(`${url} did not respond within 30s`);
    await openBrowser(url);
    send(lib.commandResultMessage(id, 'done', { url, port: payload.port, projectDir }));
  } catch (error) {
    send(await lib.finalizeFailure(config, id, error.message, log.text));
  }
}

// --- install_apk execution ----------------------------------------------------

/** Stream the APK to disk (redirects followed), enforcing the size cap. */
async function downloadApk(log, apkUrl, destPath, headers = {}) {
  const response = await fetch(apkUrl, { redirect: 'follow', headers });
  if (!response.ok || !response.body) throw new Error(`APK download failed (HTTP ${response.status})`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let received = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      cb(received > lib.APK_MAX_BYTES ? new Error('APK exceeds the 100MB limit') : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(destPath));
  } catch (error) {
    await fs.promises.rm(destPath, { force: true });
    throw error;
  }
  log.text += `Downloaded ${received} bytes → ${destPath}\n`;
}

/** Try the `am start` install intent, falling back to termux-open. */
async function launchInstallIntent(log, apkPath) {
  const { command, args } = lib.installIntentCommand(apkPath);
  const intent = await run(command, args, { timeout: 15_000 });
  log.text += `$ ${command} ${args.join(' ')}\n${intent.output}`;
  if (intent.ok) return true;
  const fallback = await run('termux-open', [apkPath], { timeout: 15_000 });
  log.text += `$ termux-open ${apkPath}\n${fallback.output}`;
  return fallback.ok;
}

/** First adb binary that answers, or null when adb is not installed. */
async function findAdb() {
  for (const candidate of lib.adbCandidates()) {
    const probe = await run(candidate, ['version'], { timeout: 10_000 });
    if (probe.ok) return candidate;
  }
  return null;
}

/** Attached devices/emulators (parseAdbDevices entries); [] when adb fails. */
async function adbDeviceSerials(log, adb) {
  const result = await run(adb, ['devices', '-l'], { timeout: 15_000 });
  log.text += `$ ${adb} devices -l\n${result.output}`;
  if (!result.ok) return [];
  return lib.parseAdbDevices(result.output);
}

/** Local path of the APK to install: the chained build output when given. */
async function obtainApk(log, config, payload) {
  if (payload.apkPath) {
    if (!fs.existsSync(payload.apkPath)) throw new Error(`APK not found at ${payload.apkPath}`);
    return payload.apkPath;
  }
  if (!payload.apkUrl) throw new Error('install_apk needs either apkUrl or apkPath in the payload');
  const destPath = lib.apkPathFor(payload.apkUrl, payload.appName);
  const headers = lib.downloadHeaders(config.server, payload.apkUrl, config.deviceToken);
  await downloadApk(log, payload.apkUrl, destPath, headers);
  return destPath;
}

async function executeInstallApk(send, config, { id, payload }) {
  const log = { text: '' };
  send(lib.commandResultMessage(id, 'running'));
  try {
    const adb = await findAdb();
    const device = adb ? lib.pickAdbDevice(await adbDeviceSerials(log, adb), payload.deviceSerial) : null;
    const apkPath = await obtainApk(log, config, payload);
    if (device) {
      await step(log, adb, ['-s', device, 'install', '-r', apkPath]);
      send(lib.commandResultMessage(id, 'done', { installedTo: device, apkPath, method: 'adb' }));
      return;
    }
    const installIntentLaunched = lib.isTermux() ? await launchInstallIntent(log, apkPath) : false;
    send(lib.commandResultMessage(id, 'done', { savedTo: apkPath, installIntentLaunched }));
  } catch (error) {
    send(await lib.finalizeFailure(config, id, error.message, log.text));
  }
}

// --- build_android execution --------------------------------------------------

/** gradlew must be executable inside the container; best-effort chmod. */
async function ensureGradlewExecutable(log, projectDir) {
  const gradlew = path.join(projectDir, 'gradlew');
  if (!fs.existsSync(gradlew)) throw new Error('gradlew not found at repo root');
  await fs.promises.chmod(gradlew, 0o755);
  log.text += 'chmod +x gradlew\n';
}

/** Run the gradle build inside the android build box image. */
async function buildApkInDocker(log, projectDir, payload) {
  const docker = await requireDocker();
  const args = lib.gradleDockerArgs({
    repoDir: projectDir,
    image: payload.image ?? 'mingc/android-build-box:1.29.0',
    gradleModule: payload.gradleModule ?? 'app',
    gradleTask: payload.gradleTask ?? 'assembleDebug',
  });
  await step(log, docker, args, { timeout: GRADLE_BUILD_TIMEOUT_MS });
}

/** POST the APK to the server, authenticated with this device's own token. */
async function uploadApk(log, config, payload, apkPath) {
  const apkName = path.basename(apkPath);
  const body = await fs.promises.readFile(apkPath);
  const response = await fetch(lib.artifactUploadUrl(payload.uploadBaseUrl, apkName), {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Device ${config.deviceToken}`,
    },
    body,
  });
  if (!response.ok) throw new Error(`APK upload failed (HTTP ${response.status})`);
  const { key } = await response.json();
  log.text += `Uploaded ${apkName} (${body.length} bytes) → ${key}\n`;
  return { artifactKey: key, apkName, sizeBytes: body.length };
}

async function executeBuildAndroid(send, config, { id, payload }) {
  const log = { text: '' };
  send(lib.commandResultMessage(id, 'running'));
  try {
    const projectDir = await ensureRepo(log, payload.repoUrl, payload.branch);
    await ensureGradlewExecutable(log, projectDir);
    await buildApkInDocker(log, projectDir, payload);
    const apkPath = lib.pickNewestApk(lib.findApkCandidates(projectDir, payload.gradleModule ?? 'app'));
    if (!apkPath) throw new Error('Build succeeded but no APK was found in the outputs');
    const result = await uploadApk(log, config, payload, apkPath);
    send(lib.commandResultMessage(id, 'done', result));
  } catch (error) {
    send(await lib.finalizeFailure(config, id, error.message, log.text));
  }
}

// --- run_desktop execution ----------------------------------------------------

/** package.json scripts of the cloned repo; throws when it is not a Node project. */
async function desktopProjectScripts(projectDir) {
  const packageJsonPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('not a Node desktop project (no package.json at repo root)');
  }
  const parsed = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
  return parsed.scripts ?? {};
}

/** Resolve the start script or throw a message that names what went wrong. */
function requireDesktopScript(scripts, requested) {
  const script = lib.pickDesktopScript(scripts, requested);
  if (script) return script;
  if (requested) throw new Error(`start script '${requested}' not found in package.json`);
  throw new Error(`no desktop start script in package.json (looked for: ${lib.DESKTOP_SCRIPT_CANDIDATES.join(', ')})`);
}

/** Tauri compiles Rust on first run — fail fast when cargo is missing. */
async function ensureCargoForTauri(log, script) {
  if (!lib.isTauriScript(script)) return;
  const cargo = await run('cargo', ['--version'], { timeout: 10_000 });
  log.text += `$ cargo --version\n${cargo.output}`;
  if (!cargo.ok) {
    throw new Error(`'${script}' needs the Rust toolchain — install it via https://rustup.rs on this device`);
  }
}

/** Launch the GUI app detached so it outlives this command. */
function spawnDesktopApp(log, projectDir, script) {
  const child = spawn('npm', ['run', script], { cwd: projectDir, detached: true, stdio: 'ignore' });
  child.unref();
  log.text += `$ npm run ${script} (detached, pid ${child.pid})\n`;
  return child;
}

/** Give the app a grace period to prove it stays up (didn't crash at startup). */
async function waitForProcessAlive(child, timeoutMs = DESKTOP_START_GRACE_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
}

async function executeRunDesktop(send, config, { id, payload }) {
  const log = { text: '' };
  send(lib.commandResultMessage(id, 'running'));
  try {
    const projectDir = await ensureRepo(log, payload.repoUrl, payload.branch);
    const script = requireDesktopScript(await desktopProjectScripts(projectDir), payload.startScript);
    await ensureCargoForTauri(log, script);
    await step(log, 'npm', ['install'], { cwd: projectDir, timeout: NPM_INSTALL_TIMEOUT_MS });
    const child = spawnDesktopApp(log, projectDir, script);
    if (!(await waitForProcessAlive(child))) {
      throw new Error(`npm run ${script} exited during startup — check the project log on the device`);
    }
    send(lib.commandResultMessage(id, 'done', {
      script,
      projectDir,
      pid: child.pid,
      note: 'The app window should open on the desktop shortly',
    }));
  } catch (error) {
    send(await lib.finalizeFailure(config, id, error.message, log.text));
  }
}

// --- run_ios execution ----------------------------------------------------------

/** Regenerate the Xcode project when the repo ships an xcodegen setup. */
async function maybeRunXcodegen(log, projectDir) {
  const dir = lib.xcodegenDir(projectDir);
  if (!dir) return false;
  const probe = await run('xcodegen', ['--version'], { timeout: 10_000 });
  log.text += `$ xcodegen --version\n${probe.output}`;
  if (!probe.ok) return false;
  await step(log, 'xcodegen', [], { cwd: dir });
  return true;
}

/**
 * UDID to target: payload.destination wins (simulator or physical device);
 * otherwise a booted simulator, else boot the first available iPhone sim.
 * Returns { udid, simulator }.
 */
async function resolveIosDestination(log, requested) {
  const list = await run('xcrun', ['simctl', 'list', 'devices', '-j'], { timeout: 30_000 });
  if (!list.ok) throw new Error('xcrun simctl failed — is Xcode installed on this device?');
  if (requested) {
    return { udid: requested, simulator: lib.isSimulatorUdid(list.output, requested) };
  }
  const booted = lib.parseBootedSimulatorUdid(list.output);
  if (booted) return { udid: booted, simulator: true };
  const iphone = lib.parseAvailableIphone(list.output);
  if (!iphone) throw new Error('No booted simulator and no available iPhone simulator found');
  await step(log, 'xcrun', ['simctl', 'boot', iphone.udid]);
  log.text += `Booted simulator ${iphone.name} (${iphone.udid})\n`;
  return { udid: iphone.udid, simulator: true };
}

/** CFBundleIdentifier of the built app, read from its Info.plist. */
async function readBundleId(log, appPath) {
  const plist = path.join(appPath, 'Info.plist');
  const result = await run('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleIdentifier', plist]);
  log.text += `$ /usr/libexec/PlistBuddy -c Print:CFBundleIdentifier ${plist}\n${result.output}`;
  const bundleId = result.output.trim();
  if (!result.ok || !bundleId) throw new Error('Could not read CFBundleIdentifier from the built app');
  return bundleId;
}

async function executeRunIos(send, config, { id, payload }) {
  const log = { text: '' };
  const progress = (text) => {
    log.text += `${text}\n`;
    send(lib.commandResultMessage(id, 'running', { progress: text }));
  };
  send(lib.commandResultMessage(id, 'running'));
  try {
    if (process.platform !== 'darwin') {
      throw new Error('run_ios needs macOS with Xcode — this device is not a Mac');
    }
    const projectDir = await ensureRepo(log, payload.repoUrl, payload.branch);
    progress('Repository ready');
    if (await maybeRunXcodegen(log, projectDir)) progress('Generated the Xcode project with xcodegen');
    const project = lib.findXcodeProject(projectDir);
    if (!project) throw new Error('No .xcodeproj or .xcworkspace found at repo root or one level deep');
    const scheme = payload.scheme ?? project.name;
    const { udid, simulator } = await resolveIosDestination(log, payload.destination);
    progress(`Building scheme ${scheme} for ${simulator ? 'simulator' : 'device'} ${udid}`);
    const derivedDataPath = path.join(projectDir, 'dd');
    const buildArgs = lib.xcodebuildArgs({
      flag: project.flag,
      projectPath: project.path,
      scheme,
      destination: simulator ? `platform=iOS Simulator,id=${udid}` : `id=${udid}`,
      derivedDataPath,
    });
    await step(log, 'xcodebuild', buildArgs, { cwd: projectDir, timeout: XCODE_BUILD_TIMEOUT_MS });
    const appPath = lib.findBuiltApp(path.join(derivedDataPath, 'Build', 'Products'));
    if (!appPath) throw new Error('Build succeeded but no .app was found in the derived data products');
    if (simulator) {
      await step(log, 'xcrun', ['simctl', 'install', udid, appPath]);
      const bundleId = await readBundleId(log, appPath);
      await step(log, 'xcrun', ['simctl', 'launch', udid, bundleId]);
      send(lib.commandResultMessage(id, 'done', { scheme, simulator: udid, appPath, bundleId, projectDir }));
      return;
    }
    // Physical device: provisioning is on the user, install is best-effort.
    await step(log, 'xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, appPath]);
    send(lib.commandResultMessage(id, 'done', { scheme, device: udid, appPath, projectDir }));
  } catch (error) {
    send(await lib.finalizeFailure(config, id, error.message, log.text));
  }
}

function executeCommand(send, config, command) {
  if (command.commandType === 'install_apk') return executeInstallApk(send, config, command);
  if (command.commandType === 'build_android') return executeBuildAndroid(send, config, command);
  if (command.commandType === 'run_desktop') return executeRunDesktop(send, config, command);
  if (command.commandType === 'run_ios') return executeRunIos(send, config, command);
  return executeRunWeb(send, config, command);
}

// --- WebSocket tunnel ---------------------------------------------------------

function createCommandQueue(send, config) {
  let tail = Promise.resolve();
  return (command) => {
    tail = tail.then(() => executeCommand(send, config, command)).catch(() => {});
    return tail;
  };
}

function scheduleReconnect(attempt, connect) {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  console.log(`Reconnecting in ${delay / 1000}s…`);
  setTimeout(() => connect(attempt + 1), delay);
}

function connect(config, meta, attempt = 0) {
  const wsUrl = lib.buildWsUrl(config.server, config.deviceToken);
  const ws = new WebSocket(wsUrl);
  let heartbeat = null;
  let capabilitiesTimer = null;
  const send = (message) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
  const sendCapabilities = () => collectCapabilities().then((c) => send(lib.capabilitiesMessage(c)));
  const enqueue = createCommandQueue(send, config);

  ws.on('open', () => {
    console.log(`Connected to ${config.server} as "${config.name}".`);
    send(lib.helloMessage(meta));
    sendCapabilities().catch(() => {});
    heartbeat = setInterval(() => send(lib.heartbeatMessage()), HEARTBEAT_MS);
    capabilitiesTimer = setInterval(() => sendCapabilities().catch(() => {}), CAPABILITIES_INTERVAL_MS);
  });
  ws.on('message', (raw) => {
    const message = lib.parseServerMessage(raw);
    if (message?.kind === 'welcome') console.log(`Server welcomed device ${message.deviceId}.`);
    if (message?.kind === 'command') enqueue(message);
  });
  ws.on('error', (error) => console.error(`Tunnel error: ${error.message}`));
  ws.on('close', (code) => {
    clearInterval(heartbeat);
    clearInterval(capabilitiesTimer);
    if (code === 4001) {
      console.error('Server rejected the device token. Re-pair with: --pair <new-code>');
      process.exit(1);
    }
    scheduleReconnect(attempt, (next) => connect(config, meta, next));
  });
}

// --- Entry --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const meta = lib.collectMeta({ dockerAvailable: await dockerAvailable() });
  if (args.pair) {
    connect(await pair(args, meta), meta);
    return;
  }
  const config = lib.loadConfig();
  if (!config) throw new Error(`No saved credentials — pair first:\n\n${USAGE}`);
  if (args.server) config.server = args.server;
  connect(config, meta);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
