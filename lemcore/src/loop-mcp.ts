// MCP bridge for the core loop: initialises an MCP session from the
// workdir's .mcp.json, registers each MCP tool on the registry, and returns
// the adapter the loop cleans up at the end of the run.

import type { McpAdapter, ToolDefinition } from './ports.js';
import { initMcpSession } from './mcp.js';
import type { ToolRegistry } from './plugin-tools.js';

/**
 * Loads MCP tools declared in `<workdir>/.mcp.json` into the registry.
 * Returns null when no MCP config exists (the common case).
 */
export async function loadMcpTools(
  workdir: string,
  secrets: string[],
  registry: ToolRegistry,
): Promise<McpAdapter | null> {
  const session = await initMcpSession(workdir, secrets);
  if (session.tools.length === 0) return null;
  const tools: ToolDefinition[] = [];
  for (const spec of session.tools) {
    const fullName = spec.function.name;
    const def: ToolDefinition = {
      name: fullName,
      description: spec.function.description,
      schema: spec.function.parameters,
      // MCP tools may have side effects the manifest cannot know about —
      // treat them as mutating so approval-gated runs pause on them.
      mutating: true,
      run: async (args) => {
        const startMs = Date.now();
        try {
          const output = await session.callTool(fullName, args);
          return {
            tool: fullName,
            title: fullName,
            outputPreview: output.slice(0, 8_000),
            durationMs: Date.now() - startMs,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            tool: fullName,
            title: fullName,
            outputPreview: `mcp tool failed: ${msg}`.slice(0, 8_000),
            durationMs: Date.now() - startMs,
            error: msg,
          };
        }
      },
    };
    registry.register(def);
    tools.push(def);
  }
  return {
    tools: () => tools,
    callTool: (fullName, args) => session.callTool(fullName, args),
    cleanup: () => session.cleanup(),
  };
}
