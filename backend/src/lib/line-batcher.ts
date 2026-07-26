// Buffers text lines and flushes them in a single batch when either maxLines
// is reached or maxDelayMs elapses. Used by the hermes runner to coalesce
// agent stdout/stderr into far fewer DB writes (one TaskEvent per batch
// instead of one per line). Guarantees a final flush on close() so no output
// is lost when the stream ends.

export type FlushFn = (lines: string[]) => Promise<void> | void;

export class LineBatcher {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly flushFn: FlushFn,
    private readonly maxLines: number,
    private readonly maxDelayMs: number,
  ) {}

  push(line: string): void {
    if (this.closed) return;
    this.buffer.push(line);
    if (this.buffer.length >= this.maxLines) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxDelayMs);
    }
  }

  flush(): void {
    this.clearTimer();
    if (this.buffer.length === 0) return;
    const lines = this.buffer;
    this.buffer = [];
    void Promise.resolve(this.flushFn(lines)).catch(() => {});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
