import { Redis } from 'ioredis';
import { config } from '../config.js';

// Shared SSE multiplexer: a SINGLE Redis subscriber (process-wide) fans out
// task-event pub/sub messages to every open SSE response for that task.
// Without this, each browser tab watching a task's live console opened its
// own Redis subscriber connection — a reconnect storm or a script opening
// hundreds of streams could exhaust Redis maxclients and take down BullMQ
// and the health check. Now one connection serves all viewers.
//
// Per-user concurrent-stream cap (SSE_MAX_PER_USER, default 10) prevents a
// single user from monopolising connections. An idle-timeout (5 min with no
// real event data) closes stale streams; the client reconnects via
// EventSource's built-in retry.

const CHANNEL_PREFIX = 'task-events:';
const SUBSCRIBE_PATTERN = 'task-events:*';
const HEARTBEAT_DATA = ': ping\n\n';
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

/** Minimal writable surface the hub pushes SSE data to (ServerResponse satisfies this). */
export interface SseResponse {
  write(data: string): boolean;
  end(): void;
}

/** Subset of ioredis needed for pattern-subscribe; enables dependency-injected tests. */
export interface SubscriberLike {
  psubscribe(pattern: string): Promise<unknown>;
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  quit(): Promise<unknown>;
}

export type SubscriberFactory = () => SubscriberLike;

interface StreamEntry {
  response: SseResponse;
  userId: string;
  lastEventAt: number;
}

export class SseHub {
  private readonly streams = new Map<string, Set<StreamEntry>>();
  private readonly perUserCount = new Map<string, number>();
  private subscriber: SubscriberLike | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    private readonly createSubscriber: SubscriberFactory,
    private readonly maxPerUser: number,
    private readonly heartbeatMs: number = DEFAULT_HEARTBEAT_MS,
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
  ) {}

  /** Atomically check the per-user cap and register. Returns false if over cap. */
  register(taskId: string, userId: string, response: SseResponse): boolean {
    this.ensureStarted();
    if ((this.perUserCount.get(userId) ?? 0) >= this.maxPerUser) return false;
    this.addStream(taskId, { response, userId, lastEventAt: Date.now() });
    this.perUserCount.set(userId, (this.perUserCount.get(userId) ?? 0) + 1);
    return true;
  }

  /** Remove a response and decrement the owner's stream count. Idempotent. */
  unregister(taskId: string, response: SseResponse): void {
    const set = this.streams.get(taskId);
    if (!set) return;
    const entry = this.findEntry(set, response);
    if (!entry) return;
    set.delete(entry);
    if (set.size === 0) this.streams.delete(taskId);
    this.decrementUserCount(entry.userId);
  }

  /** Graceful shutdown: stop sweeping, drop all viewers, quit the subscriber. */
  async close(): Promise<void> {
    this.stopSweep();
    this.streams.clear();
    this.perUserCount.clear();
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    this.started = false;
  }

  // --- internal ---

  /** Lazily create the single subscriber + sweep timer (once per process). */
  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.subscriber = this.createSubscriber();
    this.subscriber.on('pmessage', (_pat, channel, msg) => this.onPubSubMessage(channel, msg));
    this.subscriber.on('error', () => {});
    void this.subscriber.psubscribe(SUBSCRIBE_PATTERN);
    this.sweepTimer = setInterval(() => this.sweep(), this.heartbeatMs);
  }

  /** Fan a published message to every viewer of the matching task. */
  private onPubSubMessage(channel: string, message: string): void {
    const taskId = this.taskIdFromChannel(channel);
    if (!taskId) return;
    const set = this.streams.get(taskId);
    if (!set) return;
    const now = Date.now();
    for (const entry of [...set]) {
      entry.lastEventAt = now;
      this.write(taskId, entry, `data: ${message}\n\n`);
    }
  }

  /** Periodic heartbeat (keepalive) + idle-timeout close, all in one sweep. */
  private sweep(): void {
    const now = Date.now();
    const idle: Array<[string, StreamEntry]> = [];
    for (const [taskId, set] of this.streams) {
      for (const entry of set) {
        this.write(taskId, entry, HEARTBEAT_DATA);
        if (now - entry.lastEventAt >= this.idleTimeoutMs) idle.push([taskId, entry]);
      }
    }
    for (const [taskId, entry] of idle) this.closeEntry(taskId, entry);
  }

  private closeEntry(taskId: string, entry: StreamEntry): void {
    try {
      entry.response.end();
    } catch {
      /* response may already be closed */
    }
    this.unregister(taskId, entry.response);
  }

  private write(taskId: string, entry: StreamEntry, data: string): void {
    try {
      entry.response.write(data);
    } catch {
      this.closeEntry(taskId, entry);
    }
  }

  private addStream(taskId: string, entry: StreamEntry): void {
    const set = this.streams.get(taskId) ?? new Set();
    set.add(entry);
    this.streams.set(taskId, set);
  }

  private findEntry(set: Set<StreamEntry>, response: SseResponse): StreamEntry | undefined {
    for (const entry of set) if (entry.response === response) return entry;
    return undefined;
  }

  private decrementUserCount(userId: string): void {
    const count = (this.perUserCount.get(userId) ?? 0) - 1;
    if (count <= 0) this.perUserCount.delete(userId);
    else this.perUserCount.set(userId, count);
  }

  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private taskIdFromChannel(channel: string): string | null {
    if (!channel.startsWith(CHANNEL_PREFIX)) return null;
    return channel.slice(CHANNEL_PREFIX.length);
  }
}

// Process-wide singleton. The Redis connection is created lazily on first
// register() call, so importing this module is free in tests/JSON paths.
export const sseHub = new SseHub(
  () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
  config.SSE_MAX_PER_USER,
);
