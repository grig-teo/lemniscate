import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for SseHub: a shared Redis subscriber that multiplexes task-event
// fan-out to many SSE responses, with a per-user concurrent-stream cap and an
// idle-timeout safety close. The hub uses dependency injection for the Redis
// subscriber so tests can simulate pub/sub messages without a real Redis.

import { SseHub, type SseResponse, type SubscriberFactory, type SubscriberLike } from '../src/lib/sse-hub.js';

// A minimal writable that records every chunk the hub writes to it.
function fakeResponse(): SseResponse & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    write: vi.fn((data: string) => {
      written.push(data);
      return true;
    }),
    end: vi.fn(),
  };
}

// A fake Redis subscriber that captures the pmessage handler so tests can
// deliver messages as if Redis published them on `task-events:<taskId>`.
interface FakeSubscriber extends SubscriberLike {
  deliver(channel: string, message: string): void;
}

function fakeSubscriber(): FakeSubscriber {
  let handler: ((pattern: string, channel: string, message: string) => void) | null = null;
  return {
    psubscribe: vi.fn(async () => {}),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'pmessage') handler = cb as typeof handler;
      return this;
    }),
    quit: vi.fn(async () => 'OK'),
    deliver(channel: string, message: string) {
      handler?.('task-events:*', channel, message);
    },
  } as FakeSubscriber;
}

// Factory wrapper that hands out the same fake instance so the test can drive
// messages through it after the hub has registered its handler.
function fakeFactory(): { factory: SubscriberFactory; sub: FakeSubscriber } {
  const sub = fakeSubscriber();
  return { factory: () => sub, sub };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SseHub fan-out', () => {
  it('delivers a published message to every viewer of the same task', () => {
    const { factory, sub } = fakeFactory();
    const hub = new SseHub(factory, 10);
    const a = fakeResponse();
    const b = fakeResponse();

    expect(hub.register('task-1', 'user-1', a)).toBe(true);
    expect(hub.register('task-1', 'user-1', b)).toBe(true);

    sub.deliver('task-events:task-1', 'hello');

    expect(a.written).toContain('data: hello\n\n');
    expect(b.written).toContain('data: hello\n\n');
  });

  it('stops delivering to a viewer after it is unregistered', () => {
    const { factory, sub } = fakeFactory();
    const hub = new SseHub(factory, 10);
    const a = fakeResponse();
    const b = fakeResponse();

    hub.register('task-1', 'user-1', a);
    hub.register('task-1', 'user-1', b);
    hub.unregister('task-1', a);

    sub.deliver('task-events:task-1', 'second');

    expect(a.written).not.toContain('data: second\n\n');
    expect(b.written).toContain('data: second\n\n');
  });

  it('does not deliver messages for a different task', () => {
    const { factory, sub } = fakeFactory();
    const hub = new SseHub(factory, 10);
    const viewer = fakeResponse();

    hub.register('task-A', 'user-1', viewer);

    sub.deliver('task-events:task-B', 'cross-talk');

    expect(viewer.written).not.toContain('data: cross-talk\n\n');
  });
});

describe('SseHub per-user limit', () => {
  it('rejects the stream that exceeds the per-user cap', () => {
    const { factory } = fakeFactory();
    const hub = new SseHub(factory, 3);

    expect(hub.register('task-1', 'user-1', fakeResponse())).toBe(true);
    expect(hub.register('task-2', 'user-1', fakeResponse())).toBe(true);
    expect(hub.register('task-3', 'user-1', fakeResponse())).toBe(true);
    // 4th concurrent stream for the same user → rejected.
    expect(hub.register('task-4', 'user-1', fakeResponse())).toBe(false);
  });

  it('counts streams per user independently', () => {
    const { factory } = fakeFactory();
    const hub = new SseHub(factory, 2);

    expect(hub.register('task-1', 'user-A', fakeResponse())).toBe(true);
    expect(hub.register('task-1', 'user-B', fakeResponse())).toBe(true);
    // user-A can still open a second stream.
    expect(hub.register('task-2', 'user-A', fakeResponse())).toBe(true);
  });

  it('frees capacity when a stream is unregistered', () => {
    const { factory } = fakeFactory();
    const hub = new SseHub(factory, 1);
    const r = fakeResponse();

    hub.register('task-1', 'user-1', r);
    expect(hub.register('task-2', 'user-1', fakeResponse())).toBe(false);

    hub.unregister('task-1', r);
    // Capacity is reclaimed after unregister.
    expect(hub.register('task-2', 'user-1', fakeResponse())).toBe(true);
  });
});

describe('SseHub idle timeout', () => {
  it('closes a stream that receives no events for the idle period', () => {
    vi.useFakeTimers();
    const { factory } = fakeFactory();
    const hub = new SseHub(factory, 10, 100, 1_000);
    const r = fakeResponse();

    hub.register('task-1', 'user-1', r);

    vi.advanceTimersByTime(1_001);

    expect(r.end).toHaveBeenCalledTimes(1);
  });

  it('keeps a stream alive while events keep arriving', () => {
    vi.useFakeTimers();
    const { factory, sub } = fakeFactory();
    const hub = new SseHub(factory, 10, 100, 1_000);
    const r = fakeResponse();

    hub.register('task-1', 'user-1', r);

    // Real event just before the idle window elapses resets the timer.
    vi.advanceTimersByTime(900);
    sub.deliver('task-events:task-1', 'keep-alive');

    // Advance past the original deadline; the stream must still be open.
    vi.advanceTimersByTime(900);
    expect(r.end).not.toHaveBeenCalled();
  });

  it('writes SSE heartbeat comments on every sweep', () => {
    vi.useFakeTimers();
    const { factory } = fakeFactory();
    const hub = new SseHub(factory, 10, 200, 60_000);
    const r = fakeResponse();

    hub.register('task-1', 'user-1', r);
    vi.advanceTimersByTime(200);

    expect(r.written).toContain(': ping\n\n');
  });
});

describe('SseHub shutdown', () => {
  it('quits the shared subscriber on close', async () => {
    const { factory, sub } = fakeFactory();
    const hub = new SseHub(factory, 10);

    hub.register('task-1', 'user-1', fakeResponse());
    await hub.close();

    expect(sub.quit).toHaveBeenCalledTimes(1);
  });

  it('stops delivering messages after close', async () => {
    const { factory, sub } = fakeFactory();
    const hub = new SseHub(factory, 10);
    const r = fakeResponse();

    hub.register('task-1', 'user-1', r);
    await hub.close();

    sub.deliver('task-events:task-1', 'late');

    expect(r.written).not.toContain('data: late\n\n');
  });
});
