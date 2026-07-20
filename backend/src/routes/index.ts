import type { FastifyPluginAsync } from 'fastify';
import authRoutes from './auth.js';
import connectionsRoutes from './connections.js';
import repositoriesRoutes from './repositories.js';

// Aggregates all API routers. main.ts registers this plugin once:
//
//   import apiRoutes from './routes/index.js';
//   await app.register(apiRoutes);
//
// Requires @fastify/cookie to be registered first (main.ts already does).
const apiRoutes: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(connectionsRoutes, { prefix: '/api' });
  await app.register(repositoriesRoutes, { prefix: '/api' });
};

export default apiRoutes;
