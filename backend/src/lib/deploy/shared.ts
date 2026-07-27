import type { DeployStatus } from '@prisma/client';
import { decrypt } from '../crypto.js';
import { prisma } from '../prisma.js';

// Deployment-log helpers shared by every deploy target (lemniscate docker
// flow and the SSH-to-VPS flow). Single home per AGENTS.md §6.

export const LOG_CAP_CHARS = 50_000;

// Appends a line to the Deployment.log tail (capped at LOG_CAP_CHARS) so build
// and run progress is visible in the UI without unbounded row growth.
export async function appendLog(deploymentId: string, line: string): Promise<void> {
  const dep = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { log: true },
  });
  const log = `${dep?.log ?? ''}${line}\n`.slice(-LOG_CAP_CHARS);
  await prisma.deployment.update({ where: { id: deploymentId }, data: { log } });
}

export async function setDeployStatus(
  deploymentId: string,
  status: DeployStatus,
  finish = false,
): Promise<void> {
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status, ...(finish ? { finishedAt: new Date() } : {}) },
  });
}

// Decrypts the service's envEnc JSON into a {KEY: value} map and pushes the
// values into `secrets` so they are scrubbed from any captured log line.
export function parseServiceEnv(envEnc: string | null, secrets: string[]): Record<string, string> {
  if (!envEnc) return {};
  const env = JSON.parse(decrypt(envEnc)) as Record<string, string>;
  secrets.push(...Object.values(env));
  return env;
}
