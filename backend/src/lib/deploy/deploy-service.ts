import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Deployment, Prisma } from '@prisma/client';
import { config } from '../../config.js';
import { logger } from '../logger.js';
import { cloneRepository, git, type GitAuth } from '../agent-git.js';
import { decrypt } from '../crypto.js';
import { GIT_HTTP_AUTH_USERNAME, tokenlessCloneUrl } from '../git-providers.js';
import { prisma } from '../prisma.js';
import { withGitlabRefreshRetry } from '../token-refresh.js';
import { errorMessage } from '../utils.js';
import { buildImage, runAppContainer, stopRemoveContainer, tailContainerLogs, waitForHealthy } from './docker-apps.js';
import { composeDown, composeProjectName, composeUp, detectComposeFile, writeComposeEnvFile } from './compose-apps.js';
import { enqueueDeployService } from '../proposal-scheduler.js';
import { servicePath } from './slug.js';
import { appendLog, parseServiceEnv, setDeployStatus } from './shared.js';
import { deployToVps } from './vps-deploy.js';

// Job: deploy-service — dispatches on Service.deployTarget.
//
// lemniscate (default): clone the default-branch tip locally, then build+run
// using whichever build manifest lives at the repo root:
//   * a Dockerfile  → docker build + runAppContainer (blue/green via container
//     name, health-checked, Traefik-routed on the apps network).
//   * a docker-compose.{yml,yaml} / compose.{yml,yaml} → docker compose up
//     -d --build --wait with a per-deploy project name (blue/green by project;
//     the user's compose file owns ports/networks/healthchecks). Available
//     since compose v2.1.4.
// A failed build or health check removes the new container/project and keeps
// the old one serving.
//
// vps: ship the clone/build/run over SSH to the user's own VPS
// (lib/deploy/vps-deploy.ts). No Traefik routing; the app is reachable at
// http://<vps-host>:<port>.

type DeploymentWithService = Prisma.DeploymentGetPayload<{
  include: {
    service: {
      include: { repository: { include: { connection: true } }; vpsTarget: true };
    };
  };
}>;

// Creates the Deployment row and enqueues the worker job. Shared by the
// manual redeploy route and the merge-gate auto-deploy hook.
export async function queueDeployment(serviceId: string, taskId: string | null): Promise<Deployment> {
  const deployment = await prisma.deployment.create({
    data: { serviceId, taskId, commitSha: 'pending' },
  });
  await enqueueDeployService(deployment.id);
  return deployment;
}

// Build manifest kind at the repo root. A Dockerfile wins over a compose
// file when BOTH are present (the compose file is then treated as auxiliary);
// this matches the prior behavior so existing Dockerfile services keep their
// single-container, Traefik-routed flow.
type BuildMode = 'image' | 'compose';

async function detectBuildMode(workdir: string): Promise<BuildMode | null> {
  const hasDockerfile = await fs.stat(path.join(workdir, 'Dockerfile')).then(() => true).catch(() => false);
  if (hasDockerfile) return 'image';
  const composeFile = await detectComposeFile(workdir);
  return composeFile ? 'compose' : null;
}

// Clones the default-branch tip into workdir, records the resolved HEAD sha on
// the deployment row, and returns the sha. The token (and its ciphertext)
// join `secrets` for log scrubbing.
async function cloneDeploymentRepo(
  deployment: DeploymentWithService,
  workdir: string,
  secrets: string[],
): Promise<string> {
  const { service } = deployment;
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
  return sha;
}

// Blue/green via container name — the legacy single-Dockerfile flow. The new
// container runs on the isolated apps network; only after it answers the
// health probe does Service.activeContainer flip and the previous container
// get removed. Failure tears down the new container and leaves the old one.
async function runLemniscateImageDeploy(
  deployment: DeploymentWithService,
  workdir: string,
  sha: string,
  secrets: string[],
): Promise<void> {
  const { service } = deployment;
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
    throw new Error(`health check failed — keeping the previous version\nlast container logs:\n${logs}`);
  }

  await finishLemniscateDeploy(deployment, container, secrets);
}

// Blue/green by compose project name. The user's compose file owns image
// build, port publishing, networks, and (optionally) HEALTHCHECK entries; we
// bring the stack up with `--wait` so it only resolves online once every
// service is healthy (or running, for images without a HEALTHCHECK). The new
// project stays live while the old one is torn down only after success.
async function runLemniscateComposeDeploy(
  deployment: DeploymentWithService,
  workdir: string,
  secrets: string[],
): Promise<void> {
  const { service } = deployment;
  const composeFile = await detectComposeFile(workdir);
  if (!composeFile) throw new Error('no compose file found at the repository root');

  const envFile = await writeComposeEnvFile(workdir, parseServiceEnv(service.envEnc, secrets));
  await setDeployStatus(deployment.id, 'building');
  const project = composeProjectName(service.id, deployment.commitSha);
  await appendLog(deployment.id, `docker compose up (${composeFile}, project ${project})`);
  await composeUp({
    project,
    file: composeFile,
    workdir,
    envFile,
    secrets,
    onLog: (line) => void appendLog(deployment.id, line).catch(() => {}),
  });

  await finishLemniscateDeploy(deployment, project, secrets);
}

// Flips Service.activeContainer to the new handle (container name or compose
// project), then removes the previous handle via the same-modal teardown so a
// repo switching from a Dockerfile to a compose file (or back) still cleans
// the prior version correctly.
async function finishLemniscateDeploy(
  deployment: DeploymentWithService,
  newHandle: string,
  secrets: string[],
): Promise<void> {
  const { service } = deployment;
  const previous = service.activeContainer;
  await prisma.service.update({
    where: { id: service.id },
    data: { activeContainer: newHandle, status: 'online' },
  });
  if (previous && previous !== newHandle) await teardownPrevious(previous, secrets);
  await setDeployStatus(deployment.id, 'online', true);
  const url = `${config.APPS_BASE_URL}${servicePath(service.repository.connection.username, service.name)}`;
  await appendLog(deployment.id, `live at ${url}`);
}

// Removes whatever the previous deploy left running, by inspecting the handle
// format stored in Service.activeContainer:
//   * `app-<svc>-<sha8>`      → single-image container (docker rm -f).
//   * `lemniscate-<svc>-<sha8>` → compose project (docker compose down -v).
// Single home for the cross-mode teardown.
async function teardownPrevious(previousHandle: string, secrets: string[]): Promise<void> {
  if (previousHandle.startsWith('lemniscate-')) {
    await composeDown(previousHandle, secrets);
    return;
  }
  await stopRemoveContainer(previousHandle);
}

// Lemniscate-target dispatch: clone, pick the build mode from the repo root,
// then run the matching image/compose flow inside a shared workdir lifecycle.
async function runLemniscateDeploy(deployment: DeploymentWithService, secrets: string[]): Promise<void> {
  const workdir = path.join(config.AGENT_WORKDIR, `deploy-${deployment.id}`);
  try {
    const sha = await cloneDeploymentRepo(deployment, workdir, secrets);
    const mode = await detectBuildMode(workdir);
    if (!mode) {
      throw new Error('no Dockerfile and no docker-compose file at the repository root — add one to enable deployments');
    }
    await (mode === 'image'
      ? runLemniscateImageDeploy(deployment, workdir, sha, secrets)
      : runLemniscateComposeDeploy(deployment, workdir, secrets));
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

// Dispatches to the right target runner based on Service.deployTarget.
async function runDeploy(deployment: DeploymentWithService, secrets: string[]): Promise<void> {
  if (deployment.service.deployTarget === 'vps') {
    await deployToVps(deployment, secrets);
    return;
  }
  await runLemniscateDeploy(deployment, secrets);
}

export async function deployService(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: {
      service: {
        include: { repository: { include: { connection: true } }, vpsTarget: true },
      },
    },
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
