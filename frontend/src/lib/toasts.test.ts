import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearToasts,
  dismissToast,
  pushToast,
  subscribeToasts,
  snapshotToasts,
  TOAST_DURATION_MS,
} from '@/lib/toasts';

beforeEach(() => clearToasts());
afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe('pushToast', () => {
  it('appends a toast with the given message and a unique id', () => {
    const first = pushToast('boom');
    const second = pushToast('bang');
    expect(snapshotToasts()).toEqual([
      { id: first, message: 'boom' },
      { id: second, message: 'bang' },
    ]);
    expect(first).not.toBe(second);
  });

  it('auto-dismisses the toast after the toast duration', () => {
    vi.useFakeTimers();
    pushToast('temporary');
    expect(snapshotToasts()).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(snapshotToasts()).toHaveLength(0);
  });

  it('notifies subscribers when a toast is pushed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToasts(listener);
    pushToast('hello');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    pushToast('again');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('dismissToast', () => {
  it('removes only the targeted toast and cancels its auto-dismiss timer', () => {
    vi.useFakeTimers();
    const doomed = pushToast('first');
    pushToast('second');
    dismissToast(doomed);
    expect(snapshotToasts().map((t) => t.message)).toEqual(['second']);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
    expect(snapshotToasts()).toHaveLength(0);
  });

  it('is a no-op for an unknown id', () => {
    pushToast('stay');
    dismissToast(999_999);
    expect(snapshotToasts()).toHaveLength(1);
  });
});

describe('clearToasts', () => {
  it('drops every toast and pending timer', () => {
    vi.useFakeTimers();
    pushToast('a');
    pushToast('b');
    clearToasts();
    expect(snapshotToasts()).toEqual([]);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
    expect(snapshotToasts()).toEqual([]);
  });
});
