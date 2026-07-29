import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { docker } from './docker-cli.js';

// Docker Compose-based deploy path for the lemniscate target. When a repo
// ships a compose file at its root instead of (or in addition to) a
// Dockerfile, the worker brings the whole stack up with
// `docker compose -p <project> up -d --build`, treating the user's file as the
// source of truth for image build, port publishing, and networks.
//
// The pure helpers (COMPOSE_FILE_NAMES ordering, buildComposeUpArgs /
// buildComposeDownArgs, composeProjectName, detectComposeFile,
// writeComposeEnvFile) are unit-tested in tests/compose-apps.test.ts; the exec
// wrappers (composeUp/composeDown) are thin shells over docker-cli.ts.

// Ordered by preference — v1 docker-compose.* before v2 compose.*, .yml before
// .yaml so a project modernising to compose.yaml still deploys without a flag
// flip as long as the legacy file is also present.
export const COMPOSE_FILE_NAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
] as const;

// Decrypted service env is dropped into this dotenv file under the workdir so
// compose can pick it up via `--env-file` (variable substitution in the file)
// or via the service's own `env_file:` reference.
const ENV_FILE_NAME = '.lemniscate.env';

// Returns the basename of the first compose file found at the repo root, in
// preference order, or null when none is present. Pure except for the stat
// probe — no docker, no network.
export async function detectComposeFile(workdir: string): Promise<string | null> {
  for (const name of COMPOSE_FILE_NAMES) {
    const exists = await fs.stat(join(workdir, name)).then(() => true).catch(() => false);
    if (exists) return name;
  }
  return null;
}

// Deterministic compose project name: `lemniscate-<serviceId>-<sha8>`. Two
// deploys of the same service get distinct projects so the previous version
// keeps serving while the new one builds/starts (blue/green by project name).
export function composeProjectName(serviceId: string, sha: string): string {
  return `lemniscate-${serviceId}-${sha.slice(0, 8)}`;
}

// Pure argv builder for `docker compose up -d --build`. The env file path is
// passed (never the secrets) — values travel inside the file, scrubbed from
// any captured log by docker-cli.ts's redaction.
export function buildComposeUpArgs(
  project: string,
  file: string,
  envFile: string,
): string[] {
  return [
    'compose',
    '-p', project,
    '-f', file,
    '--env-file', envFile,
    'up',
    '-d',
    '--build',
    // --wait blocks until every service reports healthy (or running, for
    // images without a HEALTHCHECK) and exits non-zero on timeout/failure —
    // the compose equivalent of the image path's waitForHealthy gate, so a
    // dead container never gets marked online. Requires compose v2.1.4+.
    '--wait',
  ];
}

// Pure argv builder for `docker compose down --remove-orphans -v`. Volumes are
// removed so a redeploy starts clean (matches the single-image path's `docker
// rm -f`).
export function buildComposeDownArgs(project: string): string[] {
  return [
    'compose',
    '-p', project,
    'down',
    '--remove-orphans',
    '-v',
  ];
}

// Writes the decrypted service env as a dotenv file at <workdir>/.lemniscate.env
// and returns its absolute path. Empty env still creates an (empty) file so
// `--env-file` resolves cleanly.
export async function writeComposeEnvFile(
  workdir: string,
  env: Record<string, string>,
): Promise<string> {
  const path = join(workdir, ENV_FILE_NAME);
  const dotenv = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await fs.writeFile(path, dotenv, { mode: 0o600 });
  return path;
}

export interface ComposeUpOptions {
  project: string;
  file: string;
  workdir: string;
  envFile: string;
  // Decrypted service env, passed both via --env-file AND as the calling
  // process environment so compose's ${VAR} interpolation picks them up
  // regardless of whether the compose file references --env-file. The
  // compose file must still use ${VAR} or env_file: to inject into containers.
  env: Record<string, string>;
  secrets: string[];
  onLog: (line: string) => void;
}

// Builds + starts the compose stack. Logs the tail of compose output — as with
// the image path, only the last lines are surfaced to keep the deployment log
// bounded. Throws a scrubbed error on non-zero exit (compose prints which
// service failed).
export async function composeUp(opts: ComposeUpOptions): Promise<void> {
  const args = buildComposeUpArgs(opts.project, opts.file, opts.envFile);
  try {
    await docker(args, opts.secrets, opts.workdir, opts.env);
    const hasEnv = Object.keys(opts.env).length > 0;
    const hint = hasEnv
      ? ' (service env available via ${VAR} or env_file: .lemniscate.env)'
      : '';
    opts.onLog(`compose stack started${hint}`);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.split('\n').filter((l) => l.trim()).slice(-20).join('\n');
    throw new Error(`docker compose up failed: ${tail || e.message}`);
  }
}

// Tears down the whole compose project (containers, networks, volumes).
// Best-effort: a transient docker failure must not block the next deploy.
export async function composeDown(project: string, secrets: string[]): Promise<void> {
  await docker(buildComposeDownArgs(project), secrets).catch(() => {});
}