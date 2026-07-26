import { describe, expect, it } from 'vitest';
import { buildTraefikConfig } from '../src/lib/deploy/traefik-config.js';

// Pure Traefik HTTP-provider config builder — no environment needed.

describe('buildTraefikConfig', () => {
  it('creates a router, strip-prefix middleware, and backend per service', () => {
    const cfg = buildTraefikConfig([
      { ownerUsername: 'grig-teo', name: 'My App', port: 3000, activeContainer: 'app-1-abc' },
    ]);
    expect(cfg.http.routers['grig-teo-my-app']).toEqual({
      rule: 'PathPrefix(`/grig-teo/my-app`)',
      entryPoints: ['web'],
      service: 'grig-teo-my-app',
      middlewares: ['grig-teo-my-app-strip'],
    });
    expect(cfg.http.middlewares['grig-teo-my-app-strip']).toEqual({
      stripPrefix: { prefixes: ['/grig-teo/my-app'] },
    });
    expect(cfg.http.services['grig-teo-my-app']).toEqual({
      loadBalancer: { servers: [{ url: 'http://app-1-abc:3000' }] },
    });
  });

  it('omits empty tables when nothing is deployed', () => {
    const cfg = buildTraefikConfig([]);
    expect(cfg.http).toEqual({});
  });

  it('handles multiple services independently', () => {
    const cfg = buildTraefikConfig([
      { ownerUsername: 'a', name: 'one', port: 80, activeContainer: 'c1' },
      { ownerUsername: 'a', name: 'two', port: 8080, activeContainer: 'c2' },
    ]);
    expect(Object.keys(cfg.http.routers).sort()).toEqual(['a-one', 'a-two']);
  });
});
