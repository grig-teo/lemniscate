// Command dispatch shared by the devices routes and the deploy-android
// route: push over the WS hub when the agent is online, leave 'queued'
// otherwise (flushed on reconnect). build_android payloads are enriched
// here — defaults + uploadBaseUrl — so queued commands get fresh values too.

import { config } from '../config.js';
import { buildAndroidAgentPayload } from './device-commands.js';
import { deviceHub } from './device-hub.js';
import { prisma } from './prisma.js';

function agentPayload(type: string, payload: unknown): unknown {
  if (type !== 'build_android') return payload;
  return buildAndroidAgentPayload((payload ?? {}) as Record<string, unknown>, config.BACKEND_URL);
}

/** Push the command to the connected agent and mark it sent; false when offline. */
export async function dispatchCommand(command: {
  id: string;
  deviceId: string;
  type: string;
  payload: unknown;
}): Promise<boolean> {
  const sent = deviceHub.sendCommand(command.deviceId, {
    id: command.id,
    type: command.type,
    payload: agentPayload(command.type, command.payload),
  });
  if (!sent) return false;
  await prisma.deviceCommand.update({ where: { id: command.id }, data: { status: 'sent' } });
  return true;
}
