// Network-bound git ops (clone/fetch) intermittently hit transient errors
// (ECONNRESET, RPC failures, provider 502/503). These are almost always
// retryable — a fresh attempt a few seconds later succeeds. Extracted to its
// own module so agent-git.ts stays under the 300-line baseline.
const TRANSIENT_GIT_ERROR = /ECONNRESET|ETIMEDOUT|RPC failed|Connection reset|early EOF|502|503|fetch failed/i;

export async function withGitRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (!TRANSIENT_GIT_ERROR.test(msg)) throw err;
    await new Promise((r) => setTimeout(r, 2000 * (3 - retries)));
    return withGitRetry(fn, retries - 1);
  }
}
