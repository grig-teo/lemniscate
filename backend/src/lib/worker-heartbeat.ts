import { promises as fs, writeFileSync } from 'node:fs';

// Liveness signal for the BullMQ worker, which exposes no HTTP port: it
// rewrites this file on a timer, and the container healthcheck fails once
// the file goes stale (wedged event loop, dead process). Ticking on a timer
// — not on job completion — keeps an idle worker with an empty queue
// reporting healthy.

export const WORKER_HEARTBEAT_FILE = '/tmp/lemniscate-worker-heartbeat';
export const HEARTBEAT_INTERVAL_MS = 5_000;
// Staleness budget for the healthcheck: 6 missed beats (~30s) before the
// worker is declared unhealthy, so one slow tick doesn't flap it.
export const HEARTBEAT_MAX_AGE_MS = 30_000;

export function heartbeatIsFresh(
  mtimeMs: number | null,
  nowMs: number,
  maxAgeMs: number = HEARTBEAT_MAX_AGE_MS,
): boolean {
  if (mtimeMs === null) return false;
  return nowMs - mtimeMs < maxAgeMs;
}

// Returns a stop function; the timer is unref'd so it never keeps the
// process alive on its own. The first beat is synchronous so the file exists
// before the caller continues (the healthcheck is valid from t=0); later
// beats are fire-and-forget. Write failures are swallowed — the healthcheck
// turning unhealthy is the intended signal when /tmp is unwritable.
export function startHeartbeat(
  file: string = WORKER_HEARTBEAT_FILE,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const beat = () => {
    void fs.writeFile(file, new Date().toISOString()).catch(() => {});
  };
  try {
    writeFileSync(file, new Date().toISOString());
  } catch {
    // same swallow rule as the async beats
  }
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
