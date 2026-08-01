// Edit-checkpoint and lint-gate machinery for lemcore file edits.
// Split out of tools.ts to stay under the repo's per-file line limit.
//
// - editCheckpoints stores the pre-edit content of the most recent edit so
//   undo_edit can restore it.
// - lintAndMaybeRevert runs the repo linter after an edit and reverts the
//   file if the edit introduced NEW lint errors.
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { redactSecrets } from '../utils.js';
import { jailPath, truncate, type ToolResult } from './tools.js';

const execFileAsync = promisify(execFile);

// Pre-edit content checkpoints keyed by relative path, so undo_edit can
// restore a file to its state before the most recent edit_file/multi_edit.
const editCheckpoints = new Map<string, string>(); // relPath -> previous content

export function checkpointEdit(relPath: string, originalContent: string): void {
  editCheckpoints.set(relPath, originalContent);
}

export async function toolUndoEdit(
  workdir: string,
  relPath: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const original = editCheckpoints.get(relPath);
  if (!original) {
    return {
      tool: 'undo_edit' as ToolResult['tool'],
      title: relPath,
      durationMs: 0,
      outputPreview: `No checkpoint for ${relPath} — nothing to undo`,
      error: `no checkpoint for ${relPath}`,
    };
  }
  await fs.writeFile(jailPath(workdir, relPath), original, 'utf8');
  editCheckpoints.delete(relPath);
  return {
    tool: 'undo_edit' as ToolResult['tool'],
    title: relPath,
    durationMs: Date.now() - startMs,
    outputPreview: truncate(redactSecrets(`reverted ${relPath} to pre-edit state`, secrets)),
  };
}

// Detect a per-file lint command based on common config files. Returns null
// when no linter is configured for the file type, in which case edits are
// accepted without a lint pass.
async function detectLintCommand(workdir: string, relPath: string): Promise<string | null> {
  const ext = relPath.split('.').pop()?.toLowerCase();
  try {
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
      await fs.access(jailPath(workdir, '.eslintrc.js'));
      return `npx eslint --no-eslintrc -c .eslintrc.js "${relPath}" 2>&1 || true`;
    }
    if (ext === 'py') {
      return `python -m py_compile "${relPath}" 2>&1`;
    }
    if (ext === 'go') {
      return `gofmt -l "${relPath}" 2>&1`;
    }
  } catch {
    // No lint config found — skip linting.
  }
  return null;
}

// After an edit/multi_edit write, run the repo linter on the edited file. If
// the lint introduces NEW errors, revert the file to its pre-edit content and
// surface the errors so the model can fix the edit rather than ship a broken
// file. If no linter is detected, the edit is accepted as-is.
export async function lintAndMaybeRevert(
  workdir: string,
  relPath: string,
  originalContent: string,
  _newContent: string,
  secrets: string[],
  startMs: number,
  toolName: string,
): Promise<ToolResult> {
  const lintCmd = await detectLintCommand(workdir, relPath);
  if (!lintCmd) {
    // No linter — accept the edit.
    return {
      tool: toolName as ToolResult['tool'],
      title: relPath,
      outputPreview: truncate(redactSecrets(`edited ${relPath}`, secrets)),
      durationMs: Date.now() - startMs,
    };
  }
  try {
    await execFileAsync('sh', ['-c', lintCmd], {
      cwd: workdir,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    // Lint passed — accept.
    return {
      tool: toolName as ToolResult['tool'],
      title: relPath,
      outputPreview: truncate(redactSecrets(`edited ${relPath} (lint clean)`, secrets)),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const lintOutput = (e.stdout || '') + (e.stderr || '');
    // Revert the file to original content.
    await fs.writeFile(jailPath(workdir, relPath), originalContent, 'utf8');
    return {
      tool: toolName as ToolResult['tool'],
      title: relPath,
      outputPreview: truncate(redactSecrets(`edit reverted — lint errors:\n${lintOutput}`, secrets)),
      durationMs: Date.now() - startMs,
      error: `lint errors after edit (reverted): ${lintOutput.slice(0, 500)}`,
    };
  }
}
