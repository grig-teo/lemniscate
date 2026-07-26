// Coalesces agent stdout/stderr lines into batched TaskEvent writes.
//
// Without batching, every readline 'line' event triggers its own
// publishTaskEvent → prisma.taskEvent.create + Redis publish. A typical agent
// run produces hundreds of lines, so that is hundreds of DB writes. The
// LineBatcher collects lines and flushes them as a single { lines: string[] }
// payload, giving roughly maxBatchSize× fewer DB writes.

export interface LineBatcherOptions {
  /** Flush as soon as this many lines accumulate (default 10). */
  maxBatchSize?: number;
  /** Flush at least this often even when the batch is small (default 1 s). */
  flushIntervalMs?: number;
}

export class LineBatcher {
  private lines: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly flushFn: (lines: string[]) => Promise<void>,
    options: LineBatcherOptions = {},
  ) {
    this.maxBatchSize = options.maxBatchSize ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 1_000;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Don't keep the event loop alive solely for the flush timer — the
    // surrounding agent run owns the lifecycle.
    this.timer.unref?.();
  }

  /** Adds a line, auto-flushing when the batch reaches maxBatchSize. */
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** Flushes the current batch. A no-op when there is nothing to flush. */
  async flush(): Promise<void> {
    if (this.lines.length === 0) return;
    const batch = this.lines;
    this.lines = [];
    try {
      await this.flushFn(batch);
    } catch {
      // Swallow: a failed batch write is non-fatal, matching the per-line
      // logEvent call's .catch(() => {}).
    }
  }

  /** Stops the periodic flush timer. Call after the final flush(). */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
