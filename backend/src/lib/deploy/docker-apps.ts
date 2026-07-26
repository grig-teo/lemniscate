import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactSecrets } from '../utils.js';

// Thin docker CLI wrapper for service containers (the worker mounts the host
// docker socket). All output is secret-scrubbed before it reaches a log.
// User containers join ONLY the isolated apps network — never the platform
// network with Postgres/Redis/MinIO.

const execFileAsync = promisify(execFile);
const DOCKER_TIMEOUT_MS = 10 * 60 * 1000; // builds can be slow
const MAX_BUFFER = 8 * 1024 * 1024;

async function docker(args: string[], secrets: string[] = []): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, {
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return redactSecrets(stdout, secrets);
}

export async function buildImage(
  contextDir: string,
  imageTag: string,
  secrets: string[],
  onLog: (line: string) => void,
): Promise<void> {
  const logTail = (out: string) => {
    for (const line of out.split('\n').filter((l) => l.trim()).slice(-20)) {
      onLog(redactSecrets(line, secrets));
    }
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['build', '--pull', '-t', imageTag, '.'],
      { cwd: contextDir, timeout: DOCKER_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    logTail(`${stdout}\n${stderr}`);
  } catch (err) {
    // execFile errors carry the captured stdout/stderr — surface the tail.
    const e = err as { stdout?: string; stderr?: string; message: string };
    const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    logTail(tail);
    const lastLine = tail.split('\n').filter((l) => l.trim()).pop() ?? e.message;
    throw new Error(`docker build failed: ${redactSecrets(lastLine, secrets)}`);
  }
}

export interface RunContainerOptions {
  name: string;
  image: string;
  network: string;
  serviceId: string;
  env: Record<string, string>;
  memory: string;
  cpus: string;
}

// Starts a service container detached on the apps network. Env VALUES are
// passed via --env-file-free individual flags but never logged.
export async function runAppContainer(opts: RunContainerOptions): Promise<void> {
  const args = [
    'run', '-d',
    '--name', opts.name,
    '--network', opts.network,
    '--label', `lemniscate.service=${opts.serviceId}`,
    '--memory', opts.memory,
    '--cpus', opts.cpus,
    '--restart', 'unless-stopped',
  ];
  for (const [key, value] of Object.entries(opts.env)) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(opts.image);
  await docker(args, Object.values(opts.env));
}

export async function stopRemoveContainer(name: string): Promise<void> {
  await docker(['rm', '-f', name]).catch(() => {});
}

// First IPv4 address of the container on the given network (for direct
// health checks before traffic is routed).
export async function containerIp(name: string, network: string): Promise<string | null> {
  const out = await docker([
    'inspect', '-f', `{{index .NetworkSettings.Networks "${network}" "IPAddress"}}`, name,
  ]).catch(() => '');
  const ip = out.trim();
  return ip.length > 0 ? ip : null;
}

// Polls http://<ip>:<port>/ until 2xx-4xx (app is answering) or the attempts
// run out. A container that crashed is detected early via inspect.
export async function waitForHealthy(
  name: string,
  network: string,
  port: number,
  attempts = 30,
  intervalMs = 2_000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const state = await docker([
      'inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', name,
    ]).catch(() => '');
    if (state.startsWith('exited') || state.startsWith('dead')) return false;
    if (state.includes('healthy')) return true;
    const ip = await containerIp(name, network);
    if (ip) {
      const ok = await fetch(`http://${ip}:${port}/`, { signal: AbortSignal.timeout(2_000) })
        .then((res) => res.status < 500)
        .catch(() => false);
      if (ok) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function tailContainerLogs(name: string, lines = 200): Promise<string> {
  return docker(['logs', '--tail', String(lines), name]).catch(
    (err) => `could not read container logs: ${(err as Error).message}`,
  );
}
