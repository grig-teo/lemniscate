import { describe, expect, it } from 'vitest';
import { buildTraefikConfig } from '../src/lib/deploy/traefik-config.js';

// Pure Traefik HTTP-provider config builder — no environment needed.

const BACKEND = 'http://backend:3000';

describe('buildTraefikConfig', () => {
  it('creates a router, strip-prefix middleware, and backend per service', () => {
    const cfg = buildTraefikConfig(
      [{ ownerUsername: 'grig-teo', name: 'My App', port: 3000, activeContainer: 'app-1-abc' }],
      BACKEND,
    );
    expect(cfg.http?.routers?.['grig-teo-my-app']).toEqual({
      rule: 'PathPrefix(`/grig-teo/my-app`)',
      entryPoints: ['web'],
      service: 'grig-teo-my-app',
      middlewares: ['grig-teo-my-app-strip'],
    });
    expect(cfg.http?.middlewares?.['grig-teo-my-app-strip']).toEqual({
      stripPrefix: { prefixes: ['/grig-teo/my-app'] },
    });
    expect(cfg.http?.services?.['grig-teo-my-app']).toEqual({
      loadBalancer: { servers: [{ url: 'http://app-1-abc:3000' }] },
    });
  });

  it('adds an owner index router at /<owner>/ pointing at the backend', () => {
    const cfg = buildTraefikConfig(
      [{ ownerUsername: 'Grig-Teo', name: 'one', port: 80, activeContainer: 'c1' }],
      BACKEND,
    );
    expect(cfg.http?.routers?.['grig-teo-index']).toEqual({
      rule: 'Path(`/grig-teo`) || PathPrefix(`/grig-teo/`)',
      entryPoints: ['web'],
      service: 'grig-teo-index',
      middlewares: ['grig-teo-index-rewrite'],
    });
    expect(cfg.http?.services?.['grig-teo-index']).toEqual({
      loadBalancer: { servers: [{ url: BACKEND }] },
    });
    expect(cfg.http?.middlewares?.['grig-teo-index-rewrite']).toEqual({
      replacePath: { path: '/api/apps-index/grig-teo' },
    });
  });

  it('creates one index per distinct owner', () => {
    const cfg = buildTraefikConfig(
      [
        { ownerUsername: 'a', name: 'one', port: 80, activeContainer: 'c1' },
        { ownerUsername: 'b', name: 'two', port: 80, activeContainer: 'c2' },
        { ownerUsername: 'a', name: 'three', port: 80, activeContainer: 'c3' },
      ],
      BACKEND,
    );
    expect(cfg.http?.routers?.['a-index']).toBeDefined();
    expect(cfg.http?.routers?.['b-index']).toBeDefined();
    expect(Object.keys(cfg.http?.routers ?? {}).sort()).toEqual([
      'a-index',
      'a-one',
      'a-three',
      'b-index',
      'b-two',
    ]);
  });

  it('returns a bare empty object when nothing is deployed', () => {
    // Traefik's YAML decoder rejects empty {} maps at any level.
    expect(buildTraefikConfig([], BACKEND)).toEqual({});
  });
});
