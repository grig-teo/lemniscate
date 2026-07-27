// @vitest-environment jsdom
/**
 * Locking tests for the useAutosave hook: debounce timing, dirty detection via
 * JSON comparison, status transitions (idle → saving → saved / error), retry,
 * flush, cancel, revert-to-saved cancellation, out-of-order save protection,
 * and flush-on-unmount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useAutosave } from '@/lib/use-autosave';

/**
 * Advance fake timers AND flush the microtask queue so async saves resolve.
 * vitest's *Async timer APIs handle the interaction between fake timers and
 * promise microtasks — plain advanceTimersByTime + runAllTicks does not.
 */
async function flushTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useAutosave — initial state', () => {
  it('starts idle with no error and does not save the initial value', () => {
    const onSave = vi.fn();
    const { result } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('useAutosave — debounced save', () => {
  beforeEach(() => vi.useFakeTimers());

  it('does not save immediately on change — waits for the debounce', () => {
    const onSave = vi.fn();
    const { rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls onSave with the latest value after the debounce elapses', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    await flushTimers(1000);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ a: 2 });
  });

  it('coalesces rapid edits — only the last value is saved', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    rerender({ v: { a: 3 } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    rerender({ v: { a: 4 } });
    await flushTimers(1000);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ a: 4 });
  });

  it('respects a custom debounceMs', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ v }) => useAutosave({ value: v, onSave, debounceMs: 500 }),
      { initialProps: { v: { a: 1 } } },
    );

    rerender({ v: { a: 2 } });
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(onSave).not.toHaveBeenCalled();
    await flushTimers(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('useAutosave — status transitions', () => {
  beforeEach(() => vi.useFakeTimers());

  it('transitions idle → saving → saved on a successful save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    await flushTimers(1000);

    expect(result.current.status).toBe('saved');
    expect(result.current.error).toBeNull();
  });

  it('transitions to error on a failed save and stores the error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('network down'));
    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    await flushTimers(1000);

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('network down');
  });
});

describe('useAutosave — retry', () => {
  beforeEach(() => vi.useFakeTimers());

  it('re-attempts the save on retry after an error', async () => {
    let call = 0;
    const onSave = vi.fn().mockImplementation(() => {
      call++;
      return call === 1 ? Promise.reject(new Error('fail')) : Promise.resolve();
    });
    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    await flushTimers(1000);
    expect(result.current.status).toBe('error');

    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('saved');
  });

  it('is a no-op when status is not error', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    act(() => result.current.retry());
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('useAutosave — flush', () => {
  beforeEach(() => vi.useFakeTimers());

  it('immediately saves pending changes without waiting for the debounce', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    await act(async () => {
      await result.current.flush();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ a: 2 });
    expect(result.current.status).toBe('saved');
  });

  it('is a no-op when there are no pending changes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    await act(async () => {
      await result.current.flush();
    });
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('useAutosave — cancel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('drops pending changes so the debounce never fires', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    act(() => result.current.cancel());
    await flushTimers(2000);

    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('useAutosave — revert to saved state', () => {
  beforeEach(() => vi.useFakeTimers());

  it('cancels the pending debounce when the value reverts to the saved snapshot', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } }); // dirty
    rerender({ v: { a: 1 } }); // reverted
    await flushTimers(2000);

    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('useAutosave — enabled flag', () => {
  beforeEach(() => vi.useFakeTimers());

  it('does not save when enabled is false', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ v, enabled }) => useAutosave({ value: v, onSave, enabled }),
      { initialProps: { v: { a: 1 }, enabled: true } },
    );

    rerender({ v: { a: 2 }, enabled: false });
    await flushTimers(2000);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('useAutosave — flush on unmount', () => {
  beforeEach(() => vi.useFakeTimers());

  it('flushes pending changes when the component unmounts', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    await act(async () => {
      unmount();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ a: 2 });
  });

  it('does not flush when there are no pending changes on unmount', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    unmount();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('useAutosave — pending status during debounce', () => {
  beforeEach(() => vi.useFakeTimers());

  it('clears the saved status when new edits arrive during the debounce window', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    // First edit: save completes → status 'saved'.
    rerender({ v: { a: 2 } });
    await flushTimers(1000);
    expect(result.current.status).toBe('saved');

    // Second edit: status must NOT remain 'saved' while debouncing.
    rerender({ v: { a: 3 } });
    expect(result.current.status).toBe('idle');

    // After the debounce elapses, save fires and status returns to 'saved'.
    await flushTimers(1000);
    expect(result.current.status).toBe('saved');
  });

  it('clears the error status when new edits arrive during the debounce window', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('fail'));
    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    // First edit fails → status 'error'.
    rerender({ v: { a: 2 } });
    await flushTimers(1000);
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeInstanceOf(Error);

    // Second edit clears the error indicator while debouncing.
    rerender({ v: { a: 3 } });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });
});

describe('useAutosave — save serialization', () => {
  beforeEach(() => vi.useFakeTimers());

  it('queues a newer save behind an in-flight save so PATCH requests cannot race', async () => {
    let resolveFirst: () => void = () => {};
    const onSave = vi.fn().mockImplementation((value: { a: number }) => {
      if (value.a === 2) return new Promise<void>((r) => { resolveFirst = r; });
      return Promise.resolve();
    });

    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    // Trigger first save (value a:2) — in-flight, unresolved.
    rerender({ v: { a: 2 } });
    await flushTimers(1000);
    expect(result.current.status).toBe('saving');
    expect(onSave).toHaveBeenCalledTimes(1);

    // Edit again while save is in-flight (value a:3).
    rerender({ v: { a: 3 } });
    await flushTimers(1000);

    // The {a:3} save is queued behind the in-flight {a:2} save — it has NOT
    // been sent yet (serialization prevents overlapping PATCH requests).
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('saving');

    // Complete the first save — the queued {a:3} save now runs and resolves.
    await act(async () => {
      resolveFirst();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenNthCalledWith(2, { a: 3 });
    expect(result.current.status).toBe('saved');
  });

  it('coalesces rapid edits during an in-flight save into one queued save', async () => {
    let resolveFirst: () => void = () => {};
    const onSave = vi.fn().mockImplementation((value: { a: number }) => {
      if (value.a === 2) return new Promise<void>((r) => { resolveFirst = r; });
      return Promise.resolve();
    });

    const { result, rerender } = renderHook(({ v }) => useAutosave({ value: v, onSave }), {
      initialProps: { v: { a: 1 } },
    });

    rerender({ v: { a: 2 } });
    await flushTimers(1000);
    expect(result.current.status).toBe('saving');

    // Multiple edits while the first save is in-flight.
    rerender({ v: { a: 3 } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    rerender({ v: { a: 4 } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    rerender({ v: { a: 5 } });
    await flushTimers(1000);

    // Still only the first save has been sent; the rest are coalesced.
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Only one more save fires — with the latest value {a:5}.
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenNthCalledWith(2, { a: 5 });
    expect(result.current.status).toBe('saved');
  });
});
