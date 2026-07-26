import { servicePath, slugify } from './slug.js';

// Builds the Traefik dynamic configuration served at
// /api/internal/traefik/dynamic (HTTP provider). Pure and unit-tested
// (tests/traefik-config.test.ts).
//
// Only services with an active (healthy) container get a router — that is
// the whole blue-green mechanism: the worker flips Service.activeContainer
// after the new container passes its health check, and Traefik picks the
// change up on the next poll (~5s).
//
// Each owner with at least one live service also gets an index router at
// /<owner>/ pointing at the backend's apps-index page. Service rules are
// longer, so Traefik's default rule-length priority keeps them winning.

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

export function buildTraefikConfig(
  services: TraefikServiceInput[],
  backendUrl: string,
): TraefikDynamicConfig {
  const routers: Record<string, unknown> = {};
  const backends: Record<string, unknown> = {};
  const middlewares: Record<string, unknown> = {};
  const owners = new Set<string>();
  for (const svc of services) {
    const path = servicePath(svc.ownerUsername, svc.name);
    const key = `${path.slice(1).replace(/\//g, '-')}`;
    owners.add(slugify(svc.ownerUsername));
    routers[key] = {
      rule: `PathPrefix(\`${path}\`)`,
      entryPoints: ['web'],
      service: key,
      middlewares: [`${key}-strip`],
      // Must outrank the owner index router below — the index rule (with
      // its ||) is LONGER, so rule-length priority would pick it first.
      priority: 100,
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
  for (const owner of owners) {
    const key = `${owner}-index`;
    routers[key] = {
      rule: `Path(\`/${owner}\`) || PathPrefix(\`/${owner}/\`)`,
      entryPoints: ['web'],
      service: key,
      middlewares: [`${key}-rewrite`],
      // Catch-all for the owner namespace: every service router (100) wins.
      priority: 1,
    };
    backends[key] = { loadBalancer: { servers: [{ url: backendUrl }] } };
    middlewares[`${key}-rewrite`] = {
      replacePath: { path: `/api/apps-index/${owner}` },
    };
  }
  // Traefik's YAML decoder rejects EMPTY maps ({} values) — so with no
  // online services the payload must be a bare empty object, and once any
  // router exists every table is populated anyway (verified against
  // traefik:v3.1's file provider).
  if (Object.keys(routers).length === 0) return {};
  return { http: { routers, services: backends, middlewares } };
}
