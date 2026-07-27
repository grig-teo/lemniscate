import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config, MONITORED_SECRETS } from './config.js';
import { logger } from './lib/logger.js';
import { metrics, registerHttpMetricsHook, registerMetricsRoute } from './lib/metrics.js';
import { initErrorReporting, reportError } from './lib/sentry.js';
import { sseHub } from './lib/sse-hub.js';
import apiRoutes from './routes/index.js';
import healthRoutes from './routes/health.js';
import llmConfigRoutes from './routes/llm-configs.js';
import skillsRoutes from './routes/skills.js';
import mcpServersRoutes from './routes/mcp-servers.js';
import libraryRoutes from './routes/library.js';
import tasksRoutes from './routes/tasks.js';
import usageRoutes from './routes/usage.js';
import notificationsRoutes from './routes/notifications.js';
import devicesRoutes from './routes/devices.js';
import servicesRoutes, { servicesInternalRoutes, appsIndexRoute } from './routes/services.js';
import vpsTargetRoutes from './routes/vps-targets.js';
import eventTriggersRoutes from './routes/event-triggers.js';
import webhookRoutes from './routes/webhooks.js';

async function registerPlugins(app: FastifyInstance) {
  await app.register(cookie);
  await app.register(cors, {
    origin: config.FRONTEND_URL,
    credentials: true,
  });
  // Global throttle; stricter per-route buckets live in `config.rateLimit` on
  // the sensitive routes (auth, PAT connect, LLM test, task create).
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  // WebSocket support for the device tunnel gateway (/api/devices/ws).
  await app.register(websocket);
}

async function registerRoutes(app: FastifyInstance) {
  // Auth, git connections, repositories (prefixed /api inside the plugin).
  await app.register(apiRoutes);
  await app.register(llmConfigRoutes, { prefix: '/api/llm-configs' });
  await app.register(skillsRoutes, { prefix: '/api/skills' });
  await app.register(mcpServersRoutes, { prefix: '/api/mcp-servers' });
  await app.register(libraryRoutes, { prefix: '/api/library' });
  await app.register(devicesRoutes, { prefix: '/api/devices' });
  // tasks.ts declares its routes as `/tasks...` (same convention as
  // repositories.ts), so it mounts under /api, not /api/tasks.
  await app.register(tasksRoutes, { prefix: '/api' });
  await app.register(usageRoutes, { prefix: '/api' });
  await app.register(notificationsRoutes, { prefix: '/api/notifications' });
  await app.register(servicesRoutes, { prefix: '/api' });
  await app.register(vpsTargetRoutes, { prefix: '/api' });
  // Event trigger CRUD (mounted under /api so routes are /api/repositories/:id/triggers).
  await app.register(eventTriggersRoutes, { prefix: '/api' });
  // Traefik's HTTP provider endpoint; token-guarded, no session auth.
  await app.register(servicesInternalRoutes, { prefix: '/api' });
  // Inbound git-provider webhooks (HMAC/token verified, no session auth).
  await app.register(webhookRoutes, { prefix: '/api' });
  // Public owner index for the apps domain (Traefik rewrites /<owner> here).
  await app.register(appsIndexRoute, { prefix: '/api' });
  // Liveness (/health) + readiness (/health/ready), unprefixed.
  await app.register(healthRoutes);
  // Prometheus exposition, token-guarded (404 when METRICS_TOKEN is unset).
  registerMetricsRoute(app, metrics, config.METRICS_TOKEN);
}

// Report unexpected (5xx) errors to Sentry, then answer exactly like
// Fastify's default handler: client errors keep their status/message,
// server errors collapse to a generic 500 payload.
function registerErrorReporting(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({ error: error.name, message: error.message, statusCode });
    }
    request.log.error(error);
    reportError(error, { method: request.method, route: request.routeOptions.url });
    return reply
      .code(500)
      .send({ error: 'Internal Server Error', message: 'Internal Server Error', statusCode: 500 });
  });
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Share the base Pino logger (lib/logger.ts) with Fastify so request-scoped
    // logs (request.log) flow through the same structured-JSON pipeline as the
    // worker. Fastify v5 requires the pre-built instance via loggerInstance
    // (the logger option only accepts a config object). In test mode the
    // logger is silent.
    loggerInstance: logger as FastifyBaseLogger,
    // Honor X-Forwarded-For from the frontend nginx so rate limits key on
    // the real client IP, not the proxy's container IP (see config.ts).
    trustProxy: config.TRUST_PROXY,
  });
  // Opt-in Sentry; a no-op unless SENTRY_DSN is set.
  await initErrorReporting(config.SENTRY_DSN, MONITORED_SECRETS);
  registerErrorReporting(app);
  registerHttpMetricsHook(app, metrics);
  await registerPlugins(app);
  await registerRoutes(app);
  // Drop the shared SSE subscriber on graceful shutdown so the Redis
  // connection is released alongside the HTTP server.
  app.addHook('onClose', async () => {
    await sseHub.close();
  });
  return app;
}
