import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { redactSecrets } from '../utils.js';

// SSH-based deployment onto a user's own VPS — the 'vps' DeployTarget.
//
// The worker has no SSH library dependency on purpose: it shells out to the
// `ssh` / `sshpass` CLIs (mirrors the docker-cli wrapper in docker-apps.ts).
// Secrets travel only over the SSH-encrypted stdin (never argv) and every
// captured line is secret-scrubbed before it reaches the deployment log.
//
// The pure helpers (buildSshArgs, buildRemoteDeployScript, encodeEnvB64) are
// unit-tested in tests/vps-deploy.test.ts; the exec wrappers are thin.

const SSH_TIMEOUT_MS = 10 * 60 * 1000;
const KEY_FILE_MODE = 0o600;

// The subset of a VpsTarget row the deployer needs. authMethod is narrowed
// from the string column so the arg builder can branch without re-parsing.
export interface VpsTargetConfig {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
}

export interface RemoteDeploySpec {
  /** Tokenless clone URL (https://host/owner/repo.git). */
  cloneUrl: string;
  branch: string;
  /** Docker image tag to build remotely (e.g. <service>-<sha>). */
  image: string;
  /** Container name to start remotely. */
  container: string;
  /** Host port the app is published on (docker -p). */
  port: number;
  /** Service env vars to inject into the remote container. */
  env: Record<string, string>;
  /** Git credential token for the clone. */
  gitToken: string;
}

// base64 of "KEY=value\n" lines — one per env var. The remote script decodes
// and exports them so values never appear as plaintext in the script body and
// survive any shell-quoting edge case. Pure (no I/O).
export function encodeEnvB64(env: Record<string, string>): string {
  const dotenv = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return Buffer.from(dotenv, 'utf8').toString('base64');
}

// Ssh argument vector for the target, WITHOUT the remote command. The runner
// appends the command (or reads the script from stdin with `bash -s`).
//
// Host-key checking is disabled and the known-hosts file is pointed at
// /dev/null: a non-interactive deploy would otherwise hang on the first-run
// host-key prompt, and the target is the user's own server. Pure.
export function buildSshArgs(target: VpsTargetConfig, identityFile?: string): string[] {
  const args = [
    '-p', String(target.port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30',
  ];
  if (identityFile) {
    args.push('-o', `IdentityFile=${identityFile}`);
    // Try the supplied key only; never fall back to agent/default keys.
    args.push('-o', 'IdentitiesOnly=yes');
  }
  args.push(`${target.username}@${target.host}`);
  return args;
}

// The remote bash script. Secrets are carried as base64 on stdin (see
// runRemoteScript) and decoded into GIT_TOKEN / the app env at the top, so
// the visible script body holds no plaintext credentials. Pure — callers and
// tests assert it contains neither gitToken nor env values in the clear.
export function buildRemoteDeployScript(spec: RemoteDeploySpec): string {
  const envB64 = encodeEnvB64(spec.env);
  const tokenB64 = Buffer.from(spec.gitToken, 'utf8').toString('base64');
  // Two named FIFO-less stdin reads: env payload first, then the token. We
  // instead embed both as base64 here (transported over the encrypted SSH
  // channel) and decode locally — simpler and order-independent.
  return `set -euo pipefail
GIT_TOKEN="$(echo '${tokenB64}' | base64 -d)"
export GIT_TOKEN
echo '${envB64}' | base64 -d > /tmp/lemniscate-env-$$.txt
DEPLOY_DIR="/tmp/lemniscate-deploy-$$"
git clone --depth 1 --branch "${shellQuote(spec.branch)}" \
  "https://\\$GIT_TOKEN@${extractHost(spec.cloneUrl)}${extractPath(spec.cloneUrl)}" "$DEPLOY_DIR"
cd "$DEPLOY_DIR"
COMMIT="$(git rev-parse HEAD)"
docker build --pull -t "${spec.image}" .
docker rm -f "${spec.container}" >/dev/null 2>&1 || true
docker run -d --name "${spec.container}" --restart unless-stopped \\
  --env-file /tmp/lemniscate-env-$$.txt \\
  -p ${spec.port}:${spec.port} "${spec.image}"
for i in $(seq 1 30); do
  code="$(docker inspect -f '{{.State.Health.Status}}' "${spec.container}" 2>/dev/null || echo "")"
  if [ "$code" = "healthy" ]; then break; fi
  if docker inspect -f '{{.State.Status}}' "${spec.container}" 2>/dev/null | grep -qE 'exited|dead'; then
    echo "container exited early"; docker logs --tail 30 "${spec.container}" || true; exit 1
  fi
  sleep 2
done
rm -f /tmp/lemniscate-env-$$.txt
rm -rf "$DEPLOY_DIR"
echo "LEMNISCATE_DEPLOY_OK $COMMIT"`;
}

// --- Small pure helpers (single home for URL splitting & shell quoting) ---

function extractHost(cloneUrl: string): string {
  const noProto = cloneUrl.replace(/^https?:\/\//, '');
  const slash = noProto.indexOf('/');
  return slash >= 0 ? noProto.slice(0, slash) : noProto;
}

function extractPath(cloneUrl: string): string {
  const noProto = cloneUrl.replace(/^https?:\/\//, '');
  const slash = noProto.indexOf('/');
  return slash >= 0 ? noProto.slice(slash) : '';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// --- Execution wrappers (thin; the real work is in the pure builders) ---

// Spawns `cmd args...`, writes `input` to stdin, and resolves with the
// captured+scrubbed stdout once the process exits 0. A non-zero exit rejects
// with the scrubbed stderr/stdout tail so the caller can log it. The `env`
// option carries SSHPASS (password auth) without ever placing it in argv.
function runWithStdin(
  cmd: string,
  args: string[],
  input: string,
  secrets: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SSH_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString();
      if (code === 0) return resolve(redactSecrets(stdout, secrets));
      reject(new Error(`remote command exited ${code}: ${redactSecrets(`${stdout}\n${stderr}`, secrets)}`));
    });
    child.stdin.end(input);
  });
}

// Runs `ssh ... bash -s` with the script on stdin. For password auth the
// password is passed through sshpass's SSHPASS env var (never argv); for key
// auth the key is written to a 0600 temp file, used, then unlinked. All
// captured stdout/stderr is secret-scrubbed before it is returned.
export async function runRemoteScript(
  target: VpsTargetConfig,
  secret: string,
  script: string,
  secrets: string[],
): Promise<string> {
  const sshArgs = buildSshArgs(target);
  if (target.authMethod === 'password') {
    return runWithStdin('sshpass', ['-e', 'ssh', ...sshArgs, 'bash', '-s'], script, secrets, {
      ...process.env,
      SSHPASS: secret,
    });
  }
  const keyFile = path.join(config.AGENT_WORKDIR, `.vps-key-${randomBytes(6).toString('hex')}`);
  await fs.writeFile(keyFile, secret, { mode: KEY_FILE_MODE });
  try {
    const args = buildSshArgs(target, keyFile);
    return runWithStdin('ssh', [...args, 'bash', '-s'], script, secrets);
  } finally {
    await fs.rm(keyFile, { force: true }).catch(() => {});
  }
}

// One-shot connectivity probe (POST /api/vps-targets/:id/test): runs a trivial
// remote echo. Resolves to ok:true on success, ok:false with a scrubbed error
// otherwise.
export async function testVpsConnection(
  target: VpsTargetConfig,
  secret: string,
): Promise<{ ok: true; echo: string } | { ok: false; error: string }> {
  try {
    const out = await runRemoteScript(target, secret, 'echo lemniscate-ok', [secret]);
    return { ok: true, echo: out.trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: redactSecrets(message, [secret]).slice(0, 500) };
  }
}
