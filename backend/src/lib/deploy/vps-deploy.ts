import type { Prisma } from '@prisma/client';
import { logger } from '../logger.js';
import { decrypt } from '../crypto.js';
import { withGitlabRefreshRetry } from '../token-refresh.js';
import { GIT_HTTP_AUTH_USERNAME, tokenlessCloneUrl } from '../git-providers.js';
import { prisma } from '../prisma.js';
import { errorMessage } from '../utils.js';
import { buildRemoteDeployScript, runRemoteScript, type VpsTargetConfig } from './vps.js';
import { appendLog, parseServiceEnv, setDeployStatus } from './shared.js';

// VPS-side deployment: clone+build+run happens on the user's own server over
// SSH (see lib/deploy/vps.ts). There is no Traefik routing or apps network
// for this target — the app is reachable at http://<vps-host>:<host-port>.
// Blue/green is replaced by a stop-old/start-new on the remote host.

type VpsDeploymentPayload = Prisma.DeploymentGetPayload<{
  include: {
    service: {
      include: {
        repository: { include: { connection: true } };
        vpsTarget: true;
      };
    };
  };
}>;

export type VpsTargetRow = VpsDeploymentPayload['service']['vpsTarget'];

// Structural subset the SSH helpers actually need — decoupled from the full
// Prisma row so callers can pass a partial select. Fields used: host/port/
// username for the connection, authMethod to pick password vs key, secretEnc
// for the decrypted credential.
export interface VpsTargetCredentials {
  host: string;
  port: number;
  username: string;
  authMethod: string;
  secretEnc: string;
}

// Resolves the SSH config + decrypted credential for a VpsTarget row. The
// secret (and its ciphertext) are pushed into `secrets` for log scrubbing.
export function vpsConnection(
  vpsTarget: VpsTargetCredentials | null,
  secrets: string[],
): { config: VpsTargetConfig; secret: string } {
  if (!vpsTarget) throw new Error('service has no VPS target');
  const secret = decrypt(vpsTarget.secretEnc);
  secrets.push(secret, vpsTarget.secretEnc);
  return {
    config: {
      host: vpsTarget.host,
      port: vpsTarget.port,
      username: vpsTarget.username,
      authMethod: vpsTarget.authMethod === 'key' ? 'key' : 'password',
    },
    secret,
  };
}

// The fixed remote container name for a service — stable across deploys so the
// remote script's `docker rm -f` replaces the previous version in place.
export function vpsContainerName(serviceId: string): string {
  return `lemniscate-${serviceId}`;
}

// Host port the app is published on; reuses the service's container port.

export async function deployToVps(
  deployment: VpsDeploymentPayload,
  secrets: string[],
): Promise<void> {
  const { service } = deployment;
  if (!service.vpsTarget) throw new Error('service has no VPS target');

  const { config: vpsConfig, secret } = vpsConnection(service.vpsTarget, secrets);
  await appendLog(deployment.id, `connecting to ${vpsConfig.username}@${vpsConfig.host}:${vpsConfig.port}`);

  const token = await withGitlabRefreshRetry(service.repository.connection, async (t) => t);
  secrets.push(token, GIT_HTTP_AUTH_USERNAME);

  const container = vpsContainerName(service.id);
  const image = `lemniscate-${service.id}:${Date.now().toString(36)}`;
  // hostPort is allocated per-service at creation; fall back to the container
  // port for services created before the hostPort column existed.
  const hostPort = service.hostPort ?? service.port;
  const script = buildRemoteDeployScript({
    cloneUrl: tokenlessCloneUrl(service.repository.cloneUrl),
    branch: service.repository.defaultBranch,
    image,
    container,
    port: service.port,
    hostPort,
    env: parseServiceEnv(service.envEnc, secrets),
    gitToken: token,
  });

  await setDeployStatus(deployment.id, 'building');
  await appendLog(deployment.id, 'building and starting on the remote VPS');
  const output = await runRemoteScript(vpsConfig, secret, script, secrets);

  const commit = extractRemoteCommit(output, deployment.id);
  await prisma.deployment.update({ where: { id: deployment.id }, data: { commitSha: commit } });
  await appendLog(deployment.id, tailOutput(output, secrets));

  await prisma.service.update({
    where: { id: service.id },
    data: { activeContainer: container, status: 'online' },
  });
  await setDeployStatus(deployment.id, 'online', true);
  await appendLog(deployment.id, `live at http://${vpsConfig.host}:${hostPort}`);
}

// Stops + removes the remote container (stop endpoint). Best-effort: a
// transient SSH failure must not 500 the stop action.
export async function stopVpsContainer(
  vpsTarget: VpsTargetCredentials | null,
  containerName: string,
): Promise<void> {
  if (!vpsTarget || !containerName) return;
  const secrets: string[] = [];
  const { config, secret } = vpsConnection(vpsTarget, secrets);
  await runRemoteScript(config, secret, `docker rm -f ${containerName} || true`, secrets).catch(
    (err) => logger.warn({ err: errorMessage(err) }, 'vps stop: remote command failed'),
  );
}

// The remote script prints "LEMNISCATE_DEPLOY_OK <sha>" on success.
function extractRemoteCommit(output: string, deploymentId: string): string {
  const match = output.match(/LEMNISCATE_DEPLOY_OK (\S+)/);
  if (!match || !match[1]) {
    logger.warn({ deploymentId }, 'vps deploy: success marker missing');
    return 'remote';
  }
  return match[1].slice(0, 40);
}

function tailOutput(output: string, secrets: string[]): string {
  const tail = output.split('\n').slice(-30).join('\n');
  return secrets.reduce((acc, s) => acc.split(s).join('[redacted]'), tail);
}
