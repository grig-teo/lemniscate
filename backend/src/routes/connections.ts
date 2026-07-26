import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import {
  connectWithPat,
  deleteConnection,
  listConnections,
  optionalAuth,
  syncConnectionRepos,
} from './connection-handlers.js';
import { createConnectionRepo } from './connection-repo-create.js';

// Connections API. Thin registration layer: zod schemas live in
// connection-schemas.ts, the PAT identity store in connection-pat-store.ts,
// the handlers in connection-handlers.ts, and the create-repository flow in
// connection-repo-create.ts.

// PAT connect doubles as first-time login — keep the bucket tight.
const CONNECT_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

const connectionsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/connections', { preHandler: requireAuth }, listConnections);
  app.post(
    '/connections',
    { preHandler: optionalAuth, config: { rateLimit: CONNECT_RATE_LIMIT } },
    connectWithPat,
  );
  app.delete('/connections/:id', { preHandler: requireAuth }, deleteConnection);
  app.post('/connections/:id/sync', { preHandler: requireAuth }, syncConnectionRepos);
  app.post('/connections/:id/repositories', { preHandler: requireAuth }, createConnectionRepo);
};

// Re-export so existing consumers (tests) keep a single import site.
export { createRepoBodySchema } from './connection-schemas.js';

export default connectionsRoutes;
