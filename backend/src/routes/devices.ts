import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { requireAuth } from '../plugins/auth.js';
import {
  claimPairing,
  createCommand,
  createPairing,
  deleteDevice,
  downloadArtifact,
  listCommands,
  listDevices,
  renameDevice,
  uploadArtifact,
} from './device-handlers.js';
import { handleDeviceSocket } from './device-ws.js';

// Device pairing + reverse-tunnel gateway. The companion agent on each
// device claims a short-lived pairing code (POST /claim, public — the code
// is the credential) for a device token, then connects OUTBOUND to
// GET /ws?token=... and keeps that socket open; the server pushes
// DeviceCommands (run_web, …) through it. Register with prefix
// `/api/devices` (done in main.ts).
//
// Thin registration layer: zod schemas live in device-schemas.ts, the REST
// handlers in device-handlers.ts, and the WebSocket gateway in device-ws.ts.

const CLAIM_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;
const ARTIFACT_BODY_LIMIT = 200 * 1024 * 1024;

export default async function devicesRoutes(app: FastifyInstance) {
  // APK uploads from builder agents: raw bytes, capped at 200MB.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: ARTIFACT_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );
  app.post('/pairings', { preHandler: requireAuth }, createPairing);
  app.post('/claim', { config: { rateLimit: CLAIM_RATE_LIMIT } }, claimPairing);
  app.post('/artifacts', uploadArtifact);
  app.get('/artifacts/*', downloadArtifact);
  app.get('/', { preHandler: requireAuth }, listDevices);
  app.patch('/:id', { preHandler: requireAuth }, renameDevice);
  app.delete('/:id', { preHandler: requireAuth }, deleteDevice);
  app.get('/:id/commands', { preHandler: requireAuth }, listCommands);
  app.post('/:id/commands', { preHandler: requireAuth }, createCommand);
  app.get('/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    void handleDeviceSocket(socket, request);
  });
}

// Re-exports so existing consumers (tests) keep a single import site.
export { parseAgentMessage, type AgentMessage } from './device-schemas.js';
export { handleAgentMessage } from './device-ws.js';
