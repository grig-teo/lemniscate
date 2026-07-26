import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Production-wiring test for trustProxy (main.ts → app.ts): in Docker the
// backend only sees the nginx container's IP, and @fastify/rate-limit keys
// buckets on request.ip. Without trustProxy, X-Forwarded-For (which nginx
// sets) is ignored and every client shares ONE bucket — one abusive client
// 429s the whole deployment. With trustProxy, each real client IP gets its
// own bucket.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    devicePairing: {
      findUnique: vi.fn().mockResolvedValue(null), // 404 Invalid pairing code
    },
  },
}));

import { buildApp } from '../src/app.js';

const CLAIM_URL = '/api/devices/claim';
const CLAIM_BODY = { code: 'ABC123', name: 'agent', platform: 'web' };
// CLAIM_RATE_LIMIT in routes/devices.ts: 20 requests/minute per client IP.
const BUCKET_SIZE = 20;

function claimFrom(app: FastifyInstance, clientIp: string) {
  return app.inject({
    method: 'POST',
    url: CLAIM_URL,
    headers: { 'x-forwarded-for': clientIp },
    payload: CLAIM_BODY,
  });
}

describe('rate limiting behind the nginx proxy (trustProxy)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('exhausts a full bucket for one X-Forwarded-For client', async () => {
    app = await buildApp();
    for (let i = 0; i < BUCKET_SIZE; i += 1) {
      const response = await claimFrom(app, '203.0.113.10');
      expect(response.statusCode).toBe(404); // valid bucket spend, not 429
    }
    const overLimit = await claimFrom(app, '203.0.113.10');
    expect(overLimit.statusCode).toBe(429);
  });

  it('gives a different X-Forwarded-For client an independent bucket', async () => {
    app = await buildApp();
    for (let i = 0; i < BUCKET_SIZE; i += 1) {
      await claimFrom(app, '203.0.113.10');
    }
    const attacker = await claimFrom(app, '203.0.113.10');
    expect(attacker.statusCode).toBe(429);
    // A second client must NOT be throttled by the first client's traffic.
    const bystander = await claimFrom(app, '198.51.100.20');
    expect(bystander.statusCode).toBe(404);
    expect(bystander.statusCode).not.toBe(429);
  });
});
