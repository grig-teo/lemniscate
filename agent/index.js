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
import { execFile } from 'node:child_process';
import { WebSocket } from 'ws';
import * as lib from './lib.js';

const HEARTBEAT_MS = 25_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const HTTP_READY_TIMEOUT_MS = 30_000;

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

async function dockerAvailable() {
  return (await run('docker', ['info'], { timeout: 5_000 })).ok;
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
  await step(log, 'docker', ['compose', '-f', composeFile, 'up', '-d', '--build'], { cwd: projectDir });
}

async function runWithDockerfile(log, projectDir, port) {
  const tag = `lemniscate-${path.basename(projectDir)}`.slice(0, 60);
  await step(log, 'docker', ['build', '-t', tag, '.'], { cwd: projectDir });
  await run('docker', ['rm', '-f', tag]); // best-effort replace of a previous run
  await step(log, 'docker', ['run', '-d', '--name', tag, '-p', `${port}:${port}`, tag]);
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

async function executeRunWeb(send, { id, payload }) {
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
    send(lib.commandResultMessage(id, 'failed', { error: error.message, log: lib.tailLog(log.text) }));
  }
}

// --- WebSocket tunnel ---------------------------------------------------------

function createCommandQueue(send) {
  let tail = Promise.resolve();
  return (command) => {
    tail = tail.then(() => executeRunWeb(send, command)).catch(() => {});
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
  const send = (message) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
  const enqueue = createCommandQueue(send);

  ws.on('open', () => {
    console.log(`Connected to ${config.server} as "${config.name}".`);
    send(lib.helloMessage(meta));
    heartbeat = setInterval(() => send(lib.heartbeatMessage()), HEARTBEAT_MS);
  });
  ws.on('message', (raw) => {
    const message = lib.parseServerMessage(raw);
    if (message?.kind === 'welcome') console.log(`Server welcomed device ${message.deviceId}.`);
    if (message?.kind === 'command') enqueue(message);
  });
  ws.on('error', (error) => console.error(`Tunnel error: ${error.message}`));
  ws.on('close', (code) => {
    clearInterval(heartbeat);
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
