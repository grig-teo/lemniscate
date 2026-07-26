import { Redis } from 'ioredis';
import { config } from '../config.js';

// Shared lightweight Redis client for cheap probes (the /health/ready PING).
// NOT for BullMQ: blocking queue connections need maxRetriesPerRequest: null
// (see proposal-scheduler.ts / worker.ts). Here enableOfflineQueue: false
// makes commands reject immediately while disconnected, so a health probe
// fails fast instead of queueing until the caller times out.
let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // Probe-only client: background reconnect errors are surfaced through
    // the PING result, and must not crash the process as unhandled 'error'.
    client.on('error', () => {});
  }
  return client;
}
