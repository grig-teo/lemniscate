import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LineBatcher } from '../src/lib/line-batcher.js';

// Tests for LineBatcher: buffers lines and flushes them in a single batch
// when either maxLines is reached or maxDelayMs elapses. Guarantees a final
// flush on close() so no output is lost.

describe('LineBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes when maxLines is reached', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(flush, 3, 10_000);
    batcher.push('a');
    batcher.push('b');
    expect(flush).not.toHaveBeenCalled();
    batcher.push('c');
    expect(flush).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('flushes on the timer when maxLines is not reached', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(flush, 100, 500);
    batcher.push('line-1');
    batcher.push('line-2');
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['line-1', 'line-2']);
  });

  it('does not set a timer when the buffer is already flushed by line count', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(flush, 2, 500);
    batcher.push('a');
    batcher.push('b'); // immediate flush
    flush.mockClear();
    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();
  });

  it('flushes remaining lines on close()', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(flush, 100, 10_000);
    batcher.push('x');
    batcher.push('y');
    batcher.close();
    expect(flush).toHaveBeenCalledWith(['x', 'y']);
  });

  it('does not call flush on close when buffer is empty', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(flush, 100, 10_000);
    batcher.close();
    expect(flush).not.toHaveBeenCalled();
  });

  it('clears the timer on flush so no duplicate flush fires', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(flush, 100, 500);
    batcher.push('a');
    batcher.close(); // flush + clear timer
    flush.mockClear();
    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();
  });

  it('starts a new timer after a timer flush so subsequent lines batch', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(flush, 100, 500);
    batcher.push('first');
    vi.advanceTimersByTime(500); // timer flush
    expect(flush).toHaveBeenCalledWith(['first']);
    flush.mockClear();

    batcher.push('second');
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledWith(['second']);
  });

  it('close is idempotent (double close does not double-flush)', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(flush, 100, 10_000);
    batcher.push('a');
    batcher.close();
    batcher.close();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
