import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { heartbeatIsFresh, startHeartbeat } from '../src/lib/worker-heartbeat.js';

// The worker has no HTTP port, so its compose healthcheck reads a heartbeat
// file instead: the worker rewrites it on a timer (a wedged event loop stops
// ticking) and the healthcheck fails once the file goes stale.

const file = path.join(tmpdir(), `heartbeat-test-${process.pid}`);
let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

describe('startHeartbeat', () => {
  it('writes the heartbeat file immediately and keeps it fresh', async () => {
    stop = startHeartbeat(file, 20);
    await fs.stat(file); // would throw if the initial beat was missed
    await new Promise((resolve) => setTimeout(resolve, 60));
    const mtimeMs = (await fs.stat(file)).mtimeMs;
    expect(heartbeatIsFresh(mtimeMs, Date.now(), 1000)).toBe(true);
  });

  it('stops updating after the returned stop function runs', async () => {
    stop = startHeartbeat(file, 20);
    // Let the initial fire-and-forget beat land before snapshotting the mtime.
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    stop = null;
    // Beats are fire-and-forget: a write started just before stop() can land
    // after it. Give any in-flight beat time to finish, THEN snapshot —
    // everything after this point must be still.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = (await fs.stat(file)).mtimeMs;
    expect(after).toBe(before);
  });
});

describe('heartbeatIsFresh', () => {
  it('rejects stale and missing heartbeats', () => {
    const now = Date.now();
    expect(heartbeatIsFresh(now - 60_000, now, 30_000)).toBe(false);
    expect(heartbeatIsFresh(now - 1_000, now, 30_000)).toBe(true);
    expect(heartbeatIsFresh(null, now, 30_000)).toBe(false);
  });
});
