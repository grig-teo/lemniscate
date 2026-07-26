import { servicePath } from './slug.js';

// Builds the Traefik dynamic configuration served at
// /api/internal/traefik/dynamic (HTTP provider). Pure and unit-tested
// (tests/traefik-config.test.ts).
//
// Only services with an active (healthy) container get a router — that is
// the whole blue-green mechanism: the worker flips Service.activeContainer
// after the new container passes its health check, and Traefik picks the
// change up on the next poll (~5s).

export interface TraefikServiceInput {
  ownerUsername: string;
  name: string;
  port: number;
  activeContainer: string;
}

export interface TraefikDynamicConfig {
  http?: {
    routers?: Record<string, unknown>;
    services?: Record<string, unknown>;
    middlewares?: Record<string, unknown>;
  };
}

export function buildTraefikConfig(services: TraefikServiceInput[]): TraefikDynamicConfig {
  const routers: Record<string, unknown> = {};
  const backends: Record<string, unknown> = {};
  const middlewares: Record<string, unknown> = {};
  for (const svc of services) {
    const path = servicePath(svc.ownerUsername, svc.name);
    const key = `${path.slice(1).replace(/\//g, '-')}`;
    routers[key] = {
      rule: `PathPrefix(\`${path}\`)`,
      entryPoints: ['web'],
      service: key,
      middlewares: [`${key}-strip`],
    };
    backends[key] = {
      loadBalancer: {
        servers: [{ url: `http://${svc.activeContainer}:${svc.port}` }],
      },
    };
    middlewares[`${key}-strip`] = {
      stripPrefix: { prefixes: [path] },
    };
  }
  // Traefik's YAML decoder rejects EMPTY maps ({} values) — so with no
  // online services the payload must be a bare empty object, and once any
  // router exists every table is populated anyway (verified against
  // traefik:v3.1's file provider).
  if (Object.keys(routers).length === 0) return {};
  return { http: { routers, services: backends, middlewares } };
}
