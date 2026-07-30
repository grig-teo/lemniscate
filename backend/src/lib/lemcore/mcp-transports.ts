// MCP transports for the lemcore executor: newline-delimited JSON-RPC over
// stdio, and remote servers over SSE (server → client stream) or plain HTTP
// POST (streamable-http: the POST response itself carries the reply).

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface McpTransport {
  send(message: Record<string, unknown>): void;
  waitResponse(id: number, timeoutMs: number): Promise<JsonRpcResponse>;
  close(): Promise<void>;
}

export interface StdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RemoteConfig {
  type?: 'sse' | 'http' | 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

abstract class BaseTransport extends EventEmitter implements McpTransport {
  private pending = new Map<number, (res: JsonRpcResponse) => void>();

  abstract send(message: Record<string, unknown>): void;
  abstract close(): Promise<void>;

  protected handleMessage(raw: unknown): void {
    const message = raw as JsonRpcResponse;
    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)!(message);
      this.pending.delete(message.id);
    }
  }

  waitResponse(id: number, timeoutMs: number): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP response timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }
}

// --- stdio --------------------------------------------------------------------

class StdioTransport extends BaseTransport {
  private constructor(private proc: ChildProcess) {
    super();
  }

  static async start(cfg: StdioConfig): Promise<StdioTransport> {
    const proc = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(cfg.env ?? {}) },
    });
    const transport = new StdioTransport(proc);
    let buffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          transport.handleMessage(JSON.parse(line));
        } catch {
          // non-JSON chatter on stdout is ignored
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve());
      proc.once('error', reject);
    });
    return transport;
  }

  send(message: Record<string, unknown>): void {
    this.proc.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.proc.kill('SIGTERM');
  }
}

export function stdioTransport(cfg: StdioConfig): Promise<McpTransport> {
  return StdioTransport.start(cfg);
}

// --- remote (SSE / streamable-http) --------------------------------------------

class HttpTransport extends BaseTransport {
  private sessionId: string | null = null;
  private sseAbort: AbortController | null = null;

  private constructor(
    private url: string,
    private headers: Record<string, string>,
    wantsSse: boolean,
  ) {
    super();
    if (wantsSse) this.openSseStream();
  }

  static connect(cfg: RemoteConfig): HttpTransport {
    const wantsSse = cfg.type !== 'http' && cfg.type !== 'streamable-http';
    return new HttpTransport(cfg.url, cfg.headers ?? {}, wantsSse);
  }

  // Minimal SSE reader over fetch: parses `data:` lines from the stream and
  // feeds each JSON payload to handleMessage.
  private openSseStream(): void {
    this.sseAbort = new AbortController();
    void fetch(this.url, {
      headers: { accept: 'text/event-stream', ...this.headers },
      signal: this.sseAbort.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            this.handleSseFrame(frame);
          }
        }
      })
      .catch(() => {
        // SSE loss is non-fatal: the caller sees response timeouts instead.
      });
  }

  private handleSseFrame(frame: string): void {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        this.handleMessage(JSON.parse(line.slice(5).trim()));
      } catch {
        // malformed server push — ignore
      }
    }
  }

  send(message: Record<string, unknown>): void {
    void fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.headers,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify(message),
    })
      .then(async (res) => {
        const sessionHeader = res.headers.get('mcp-session-id');
        if (sessionHeader) this.sessionId = sessionHeader;
        // streamable-http servers may answer POSTs directly (no SSE channel).
        if (!this.sseAbort && res.ok) {
          const text = await res.text();
          if (text) {
            try {
              this.handleMessage(JSON.parse(text));
            } catch {
              // empty/204-style responses are fine for notifications
            }
          }
        }
      })
      .catch(() => {
        // surfaced as a response timeout by waitResponse
      });
  }

  async close(): Promise<void> {
    this.sseAbort?.abort();
  }
}

export function httpTransport(cfg: RemoteConfig): McpTransport {
  return HttpTransport.connect(cfg);
}
