import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { METRICS_CONTENT_TYPE, renderMetrics } from '../lib/metrics.js';
import { safeEqualSecret } from '../lib/secret-compare.js';

// Prometheus exposition for the API process. Shared-secret guarded instead of
// session auth: a Prometheus scraper cannot send cookies, and the payload is
// aggregate-only (no per-user data). Accepts the Traefik-style
// x-metrics-token header or a Bearer token (scrape_config `authorization`).
// Empty configured token = endpoint disabled (503), same convention as
// /api/internal/traefik/dynamic. The worker's :3100/metrics is the
// unauthenticated counterpart on the internal network.

function presentedToken(request: FastifyRequest): string | undefined {
  const header = request.headers['x-metrics-token'];
  if (typeof header === 'string') return header;
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return undefined;
}

function guardMetrics(request: FastifyRequest, reply: FastifyReply, token: string): boolean {
  if (!token) {
    void reply.code(503).send({ error: 'metrics endpoint is not configured' });
    return false;
  }
  if (!safeEqualSecret(presentedToken(request), token)) {
    void reply.code(401).send({ error: 'invalid metrics token' });
    return false;
  }
  return true;
}

export function registerMetricsRoutes(app: FastifyInstance, token: string): void {
  app.get('/metrics', async (request, reply) => {
    if (!guardMetrics(request, reply, token)) return;
    return reply.type(METRICS_CONTENT_TYPE).send(await renderMetrics());
  });
}

export default async function metricsRoutes(app: FastifyInstance): Promise<void> {
  registerMetricsRoutes(app, config.METRICS_TOKEN);
}
