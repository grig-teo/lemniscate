import { describe, expect, it, vi } from 'vitest';

import { LineBatcher } from '../src/lib/line-batcher.js';

// Unit tests for the LineBatcher class: it coalesces agent stdout/stderr lines
// into batched TaskEvent writes to reduce DB load (~10× fewer rows).

// Allows the microtask queue to drain so fire-and-forget flush() calls resolve
// before assertions run.
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('LineBatcher', () => {
  it('accumulates lines without flushing until maxBatchSize', () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const batcher = new LineBatcher(flushFn, { maxBatchSize: 5, flushIntervalMs: 10_000 });
    batcher.push('a');
    batcher.push('b');
    expect(flushFn).not.toHaveBeenCalled();
    batcher.close();
  });

  it('auto-flushes when the batch reaches maxBatchSize', async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const batcher = new LineBatcher(flushFn, { maxBatchSize: 3, flushIntervalMs: 10_000 });
    batcher.push('a');
    batcher.push('b');
    batcher.push('c');
    await flushMicrotasks();
    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn).toHaveBeenCalledWith(['a', 'b', 'c']);
    batcher.close();
  });

  it('flush writes the accumulated batch and clears the buffer', async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const batcher = new LineBatcher(flushFn, { maxBatchSize: 100, flushIntervalMs: 10_000 });
    batcher.push('x');
    batcher.push('y');
    await batcher.flush();
    expect(flushFn).toHaveBeenCalledWith(['x', 'y']);
    // Second flush is a no-op — buffer was cleared.
    await batcher.flush();
    expect(flushFn).toHaveBeenCalledTimes(1);
    batcher.close();
  });

  it('flush is a no-op when the buffer is empty', async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const batcher = new LineBatcher(flushFn);
    await batcher.flush();
    expect(flushFn).not.toHaveBeenCalled();
    batcher.close();
  });

  it('swallows flush errors so a failed DB write is non-fatal', async () => {
    const flushFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const batcher = new LineBatcher(flushFn, { maxBatchSize: 100, flushIntervalMs: 10_000 });
    batcher.push('line');
    // Should not throw.
    await expect(batcher.flush()).resolves.toBeUndefined();
    batcher.close();
  });

  it('flushes on the periodic timer', async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const batcher = new LineBatcher(flushFn, { maxBatchSize: 100, flushIntervalMs: 10 });
    batcher.push('timed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(flushFn).toHaveBeenCalledWith(['timed']);
    batcher.close();
  });

  it('close stops the periodic timer', async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const batcher = new LineBatcher(flushFn, { maxBatchSize: 100, flushIntervalMs: 10 });
    batcher.push('first');
    batcher.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Timer-driven flush after close must not fire.
    expect(flushFn).not.toHaveBeenCalled();
  });

  it('accumulates across multiple batches without interleaving', async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const batcher = new LineBatcher(flushFn, { maxBatchSize: 2, flushIntervalMs: 10_000 });
    batcher.push('a');
    batcher.push('b');
    await flushMicrotasks();
    batcher.push('c');
    batcher.push('d');
    await flushMicrotasks();
    expect(flushFn).toHaveBeenNthCalledWith(1, ['a', 'b']);
    expect(flushFn).toHaveBeenNthCalledWith(2, ['c', 'd']);
    batcher.close();
  });
});
