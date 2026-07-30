// lemcore tool plugin SDK (Phase 9 §8). Tools are plain ToolDefinition
// objects in a registry; third-party tools ship as `.lemniscate/tools/
// *.tool.mjs` files inside the workdir and are validated against a zod
// manifest before loading. Plugin tools are jailed like built-ins (their
// runner receives the same ToolContext) and approval-gated by the host when
// they are marked mutating.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { CoreToolResult, CoreToolSpec } from './core-types.js';
import type { ToolContext, ToolDefinition } from './ports.js';
import { jailPath } from './tools.js';
import { errorMessage } from './utils.js';

export const PLUGIN_TOOLS_DIR = path.join('.lemniscate', 'tools');
export const PLUGIN_TOOL_SUFFIX = '.tool.mjs';

// Manifest contract for a plugin tool file. `schema` is a JSON Schema
// object passed through to the model verbatim.
export const toolManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'tool names are lowercase snake_case'),
  description: z.string().min(1).max(500),
  schema: z.record(z.unknown()),
  mutating: z.boolean().default(false),
  run: z
    .function()
    .args(z.record(z.unknown()), z.unknown())
    .returns(z.promise(z.unknown())),
});
export type ToolManifest = z.infer<typeof toolManifestSchema>;

export interface PluginLoadIssue {
  file: string;
  error: string;
}

export interface PluginLoadResult {
  tools: ToolDefinition[];
  issues: PluginLoadIssue[];
}

/** Wraps a validated manifest into a registry ToolDefinition. */
export function toolFromManifest(manifest: ToolManifest, file: string): ToolDefinition {
  return {
    name: manifest.name,
    description: manifest.description,
    schema: manifest.schema,
    mutating: manifest.mutating,
    run: async (args, ctx) => {
      const raw = await manifest.run(args, ctx);
      return normalizePluginResult(manifest.name, raw, file);
    },
  };
}

// Plugins may return a full CoreToolResult or a bare string (output preview).
function normalizePluginResult(name: string, raw: unknown, file: string): CoreToolResult {
  if (typeof raw === 'string') {
    return { tool: name, title: name, outputPreview: raw.slice(0, 8_000), durationMs: 0 };
  }
  const result = raw as Partial<CoreToolResult> | null;
  if (!result || typeof result.outputPreview !== 'string') {
    throw new Error(`plugin tool ${name} (${file}) returned an invalid result`);
  }
  return {
    tool: name,
    title: typeof result.title === 'string' ? result.title : name,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    outputPreview: result.outputPreview.slice(0, 8_000),
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** Scans `<workdir>/.lemniscate/tools/*.tool.mjs`; invalid files are
 * reported as issues and skipped (never abort the run). */
export async function loadPluginTools(workdir: string): Promise<PluginLoadResult> {
  const dir = jailPath(workdir, PLUGIN_TOOLS_DIR);
  const issues: PluginLoadIssue[] = [];
  const tools: ToolDefinition[] = [];
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith(PLUGIN_TOOL_SUFFIX)).sort();
  } catch {
    return { tools, issues }; // no plugin dir — fine
  }
  const seen = new Set<string>();
  for (const file of entries) {
    const abs = jailPath(workdir, path.join(PLUGIN_TOOLS_DIR, file));
    try {
      const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
      const manifest = toolManifestSchema.parse(mod.default);
      if (seen.has(manifest.name)) throw new Error(`duplicate tool name: ${manifest.name}`);
      seen.add(manifest.name);
      tools.push(toolFromManifest(manifest, file));
    } catch (err) {
      issues.push({ file, error: errorMessage(err).slice(0, 500) });
    }
  }
  return { tools, issues };
}

/** In-memory tool registry: built-ins first, then plugins/MCP tools. */
export class ToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.defs.set(def.name, def);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  isMutating(name: string): boolean {
    return this.defs.get(name)?.mutating ?? false;
  }

  list(): CoreToolSpec[] {
    return [...this.defs.values()].map((def) => ({
      type: 'function' as const,
      function: { name: def.name, description: def.description, parameters: def.schema },
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<CoreToolResult> {
    const def = this.defs.get(name);
    if (!def) {
      return {
        tool: name,
        title: name,
        outputPreview: `unknown tool: ${name}`,
        durationMs: 0,
        error: `unknown tool: ${name}`,
      };
    }
    return def.run(args, ctx);
  }
}
