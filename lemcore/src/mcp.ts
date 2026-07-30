// MCP client core: config parsing, JSON-RPC client, and session assembly.
// Transport implementations live in mcp-transports.ts.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CoreToolSpec } from './core-types.js';
import { redactSecrets } from './utils.js';
import { httpTransport, stdioTransport, type McpTransport } from './mcp-transports.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_MAX_OUTPUT_CHARS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

export interface McpServerHandle {
  name: string;
  tools: CoreToolSpec[];
  callTool(tool: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export interface McpServerInitError {
  server: string;
  message: string;
}

export interface McpSession {
  tools: CoreToolSpec[];
  errors: McpServerInitError[];
  callTool(fullName: string, args: Record<string, unknown>): Promise<string>;
  cleanup(): Promise<void>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// --- .mcp.json parsing ------------------------------------------------------

const stdioConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const remoteConfigSchema = z
  .object({
    type: z.enum(['sse', 'http', 'streamable-http']).optional(),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const serverConfigSchema = z.union([stdioConfigSchema, remoteConfigSchema]);
export type McpServerConfig = z.infer<typeof serverConfigSchema>;

export async function readMcpConfig(workdir: string): Promise<Record<string, McpServerConfig>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workdir, '.mcp.json'), 'utf8');
  } catch {
    return {};
  }
  const parsed = z
    .object({ mcpServers: z.record(serverConfigSchema) })
    .safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data.mcpServers : {};
}

// --- session ----------------------------------------------------------------

/**
 * Connects to every configured server; failures are collected into
 * `session.errors` (the caller logs them as agent_step events) instead of
 * throwing, so one bad server never kills the run.
 */
export async function initMcpSession(workdir: string, secrets: string[]): Promise<McpSession> {
  const servers = await readMcpConfig(workdir);
  const handles: McpServerHandle[] = [];
  const errors: McpServerInitError[] = [];
  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      handles.push(await connectServer(name, serverConfig));
    } catch (err) {
      errors.push({
        server: name,
        message: redactSecrets(err instanceof Error ? err.message : String(err), secrets),
      });
    }
  }
  return assembleSession(handles, errors);
}

function assembleSession(handles: McpServerHandle[], errors: McpServerInitError[]): McpSession {
  const byTool = new Map<string, McpServerHandle>();
  const tools: CoreToolSpec[] = [];
  for (const handle of handles) {
    for (const tool of handle.tools) {
      tools.push(tool);
      byTool.set(tool.function.name, handle);
    }
  }
  return {
    tools,
    errors,
    async callTool(fullName, args) {
      const handle = byTool.get(fullName);
      if (!handle) throw new Error(`unknown MCP tool: ${fullName}`);
      const shortName = fullName.slice(`mcp__${handle.name}__`.length);
      return handle.callTool(shortName, args);
    },
    async cleanup() {
      await Promise.allSettled(handles.map((h) => h.close()));
    },
  };
}

async function connectServer(name: string, config: McpServerConfig): Promise<McpServerHandle> {
  const transport: McpTransport =
    'command' in config ? await stdioTransport(config) : httpTransport(config);
  const client = new McpClient(transport);
  await client.initialize();
  const listed = await client.listTools();
  return {
    name,
    tools: listed.map((tool) => mcpToolToChatTool(name, tool)),
    callTool: (tool, args) => client.callTool(tool, args),
    close: () => transport.close(),
  };
}

// Tool names are namespaced per server so collisions across servers are
// impossible and the origin shows up in the timeline card.
function mcpToolToChatTool(server: string, tool: McpToolInfo): CoreToolSpec {
  return {
    type: 'function',
    function: {
      name: `mcp__${server}__${tool.name}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${server}`,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  };
}

// --- JSON-RPC client ----------------------------------------------------------

export class McpClient {
  private nextId = 1;

  constructor(private transport: McpTransport) {}

  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    this.transport.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const res = await this.transport.waitResponse(id, CALL_TIMEOUT_MS);
    if (res.error) throw new Error(res.error.message ?? `MCP ${method} failed`);
    return res.result as T;
  }

  async initialize(): Promise<void> {
    const id = this.nextId++;
    this.transport.send({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'lemcore', version: '1.0.0' },
      },
    });
    const res = await this.transport.waitResponse(id, HANDSHAKE_TIMEOUT_MS);
    if (res.error) throw new Error(res.error.message ?? 'MCP initialize failed');
    this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request<{ tools?: McpToolInfo[] }>('tools/list');
    return result?.tools ?? [];
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ content?: unknown; isError?: boolean }>(
      'tools/call',
      { name: tool, arguments: args },
    );
    const text = formatToolContent(result?.content);
    const capped =
      text.length > MCP_MAX_OUTPUT_CHARS ? `${text.slice(0, MCP_MAX_OUTPUT_CHARS)}…` : text;
    return result?.isError ? `MCP tool error: ${capped}` : capped;
  }
}

function formatToolContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part) return String(part.text);
      return JSON.stringify(part);
    })
    .join('\n');
}
