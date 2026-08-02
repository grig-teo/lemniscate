// Up-front validation of the `path` argument for path-taking tools.
// Extracted from loop-tool-runner.ts to keep that module under the 300-line
// guard (AGENTS.md §2). A missing or blank `path` must never reach fs as the
// bare workdir: without this guard, edit_file/read_file called with an empty
// path surface Node's raw "EISDIR … open '<workdir>'" in the console instead
// of an actionable error.
import type { ToolName, ToolResult } from './tools.js';

const PATH_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'multi_edit',
  'undo_edit',
  'list_dir',
]);

// Rejects file-path tool calls whose `path` argument is missing or blank
// (whitespace-only). Returns the error ToolResult, or null when the call is
// fine — either a non-path tool or a path that is present.
export function assertFilePathArg(name: string, args: Record<string, unknown>): ToolResult | null {
  if (!PATH_TOOLS.has(name)) return null;
  const raw = args.path;
  if (raw !== undefined && String(raw ?? '').trim() !== '') return null;
  const shown = raw === undefined || raw === null ? '(missing)' : String(raw);
  const msg = `${name}: a non-empty "path" argument is required (received ${shown}) — pass a path relative to the workdir`;
  return {
    tool: name as ToolName,
    title: `${name}(${shown})`,
    outputPreview: msg,
    durationMs: 0,
    error: msg,
  };
}
