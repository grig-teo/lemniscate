import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeployStatus, Deployment, Prisma } from '@prisma/client';
import { config } from '../../config.js';
import { logger } from '../logger.js';
import { cloneRepository, git, type GitAuth } from '../agent-git.js';
import { decrypt } from '../crypto.js';
import { GIT_HTTP_AUTH_USERNAME, tokenlessCloneUrl } from '../git-providers.js';
import { prisma } from '../prisma.js';
import { withGitlabRefreshRetry } from '../token-refresh.js';
import { errorMessage } from '../utils.js';
import { buildImage, runAppContainer, stopRemoveContainer, tailContainerLogs, waitForHealthy } from './docker-apps.js';
import { enqueueDeployService } from '../proposal-scheduler.js';
import { servicePath } from './slug.js';

// Job: deploy-service — clone the default branch tip, docker build, start
// the new container on the isolated apps network, health-check it, and only
// then flip Service.activeContainer (Traefik routes it ~5s later). A failed
// build or health check removes the new container and keeps the old one
// serving (keep-old-on-failure).

const LOG_CAP_CHARS = 50_000;

type DeploymentWithService = Prisma.DeploymentGetPayload<{
  include: { service: { include: { repository: { include: { connection: true } } } } };
}>;

async function appendLog(deploymentId: string, line: string): Promise<void> {
  const dep = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { log: true },
  });
  const log = `${dep?.log ?? ''}${line}\n`.slice(-LOG_CAP_CHARS);
  await prisma.deployment.update({ where: { id: deploymentId }, data: { log } });
}

async function setDeployStatus(
  deploymentId: string,
  status: DeployStatus,
  finish = false,
): Promise<void> {
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status, ...(finish ? { finishedAt: new Date() } : {}) },
  });
}

// Creates the Deployment row and enqueues the worker job. Shared by the
// manual redeploy route and the merge-gate auto-deploy hook.
export async function queueDeployment(serviceId: string, taskId: string | null): Promise<Deployment> {
  const deployment = await prisma.deployment.create({
    data: { serviceId, taskId, commitSha: 'pending' },
  });
  await enqueueDeployService(deployment.id);
  return deployment;
}

function parseServiceEnv(envEnc: string | null, secrets: string[]): Record<string, string> {
  if (!envEnc) return {};
  const env = JSON.parse(decrypt(envEnc)) as Record<string, string>;
  secrets.push(...Object.values(env));
  return env;
}

async function runDeploy(deployment: DeploymentWithService, secrets: string[]): Promise<void> {
  const { service } = deployment;
  const workdir = path.join(config.AGENT_WORKDIR, `deploy-${deployment.id}`);
  try {
    const token = await withGitlabRefreshRetry(service.repository.connection, async (t) => t);
    secrets.push(token);
    await appendLog(deployment.id, `cloning ${service.repository.fullName} (${service.repository.defaultBranch})`);
    await cloneRepository(
      workdir,
      tokenlessCloneUrl(service.repository.cloneUrl),
      service.repository.defaultBranch,
      secrets,
      { auth: { username: GIT_HTTP_AUTH_USERNAME, token } satisfies GitAuth },
    );
    const sha = (await git(['rev-parse', 'HEAD'], { cwd: workdir })).trim();
    await prisma.deployment.update({ where: { id: deployment.id }, data: { commitSha: sha } });
    if (!(await fs.stat(path.join(workdir, 'Dockerfile')).catch(() => null))) {
      throw new Error('no Dockerfile at the repository root — add one to enable deployments');
    }

    await setDeployStatus(deployment.id, 'building');
    const image = `lemniscate-app-${service.id}:${sha.slice(0, 12)}`;
    await appendLog(deployment.id, `building image ${image}`);
    await buildImage(workdir, image, secrets, (line) =>
      void appendLog(deployment.id, line).catch(() => {}),
    );

    await setDeployStatus(deployment.id, 'starting');
    const container = `app-${service.id}-${sha.slice(0, 8)}`;
    await runAppContainer({
      name: container,
      image,
      network: config.APPS_NETWORK,
      serviceId: service.id,
      env: parseServiceEnv(service.envEnc, secrets),
      memory: config.APPS_CONTAINER_MEMORY,
      cpus: config.APPS_CONTAINER_CPUS,
    });

    await setDeployStatus(deployment.id, 'checking');
    await appendLog(deployment.id, 'waiting for the new container to answer');
    const healthy = await waitForHealthy(container, config.APPS_NETWORK, service.port);
    if (!healthy) {
      const logs = await tailContainerLogs(container, 50);
      await stopRemoveContainer(container);
      throw new Error(
        `health check failed — keeping the previous version\nlast container logs:\n${logs}`,
      );
    }

    const previous = service.activeContainer;
    await prisma.service.update({
      where: { id: service.id },
      data: { activeContainer: container, status: 'online' },
    });
    if (previous && previous !== container) await stopRemoveContainer(previous);
    await setDeployStatus(deployment.id, 'online', true);
    const url = `${config.APPS_BASE_URL}${servicePath(service.repository.connection.username, service.name)}`;
    await appendLog(deployment.id, `live at ${url}`);
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function deployService(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { service: { include: { repository: { include: { connection: true } } } } },
  });
  if (!deployment) {
    logger.error({ deploymentId }, 'deploy-service: deployment not found');
    return;
  }
  const secrets: string[] = [];
  try {
    await prisma.service.update({
      where: { id: deployment.serviceId },
      data: { status: 'deploying' },
    });
    await runDeploy(deployment, secrets);
  } catch (err) {
    const message = errorMessage(err).slice(0, 2_000);
    await appendLog(deploymentId, `error: ${message}`).catch(() => {});
    await setDeployStatus(deploymentId, 'failed', true).catch(() => {});
    // Keep serving the previous container; only mark the service failed when
    // nothing is live at all.
    await prisma.service
      .update({
        where: { id: deployment.serviceId },
        data: { status: deployment.service.activeContainer ? 'online' : 'failed' },
      })
      .catch(() => {});
    throw err; // BullMQ retries once; the final failure stays as marked.
  }
}
