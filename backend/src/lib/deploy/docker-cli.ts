import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactSecrets } from '../utils.js';

// Single home for the thin `docker` CLI wrapper shared by docker-apps.ts (image
// build/run flow) and compose-apps.ts (docker compose flow). Mirrors the
// per-command timeout/maxBuffer/redaction policy required by AGENTS.md §6 —
// the previous private copy in docker-apps.ts has been replaced by an import
// of this module so the two flows cannot diverge.

const execFileAsync = promisify(execFile);

export const DOCKER_TIMEOUT_MS = 10 * 60 * 1000; // builds can be slow
export const MAX_BUFFER = 8 * 1024 * 1024;

// Runs `docker <args>`, returns the (secret-scrubbed) stdout. The worker
// mounts the host docker socket; user containers join ONLY the isolated apps
// network — never the platform network with Postgres/Redis/MinIO.
export async function docker(args: string[], secrets: string[] = [], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, {
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    ...(cwd ? { cwd } : {}),
  });
  return redactSecrets(stdout, secrets);
}