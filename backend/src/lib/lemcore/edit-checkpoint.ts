// Edit-checkpoint and lint-gate machinery for lemcore file edits.
// Split out of tools.ts to stay under the repo's per-file line limit.
//
// - editCheckpoints stores the pre-edit content of the most recent edit so
//   undo_edit can restore it, keyed by workdir so concurrent runs don't share.
// - lintAndMaybeRevert runs the repo linter after an edit and reverts the
//   file if the edit introduced NEW lint errors (proper before/after diff).
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../utils.js';
import { buildEditDiff } from './edit-diff.js';
import { jailPath, truncate, type ToolResult } from './tools.js';

const execFileAsync = promisify(execFile);

// Pre-edit content checkpoints keyed by workdir → relPath → previous content,
// so undo_edit can restore a file to its state before the most recent edit and
// concurrent runs don't clobber each other's checkpoints.
const editCheckpoints = new Map<string, Map<string, string>>();

export function checkpointEdit(workdir: string, relPath: string, originalContent: string): void {
  if (!editCheckpoints.has(workdir)) editCheckpoints.set(workdir, new Map());
  editCheckpoints.get(workdir)!.set(relPath, originalContent);
}

export function getCheckpoint(workdir: string, relPath: string): string | undefined {
  return editCheckpoints.get(workdir)?.get(relPath);
}

export function deleteCheckpoint(workdir: string, relPath: string): void {
  editCheckpoints.get(workdir)?.delete(relPath);
}

export function clearCheckpoints(workdir: string): void {
  editCheckpoints.delete(workdir);
}

export async function toolUndoEdit(
  workdir: string,
  relPath: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const original = getCheckpoint(workdir, relPath);
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
  deleteCheckpoint(workdir, relPath);
  return {
    tool: 'undo_edit' as ToolResult['tool'],
    title: relPath,
    durationMs: Date.now() - startMs,
    outputPreview: truncate(redactSecrets(`reverted ${relPath} to pre-edit state`, secrets)),
  };
}

// Detect ALL common lint configs (legacy + flat eslint), not just .eslintrc.js.
// Returns null when no linter is configured for the file type, in which case
// edits are accepted without a lint pass.
async function detectLintCommand(workdir: string, relPath: string): Promise<string | null> {
  const ext = relPath.split('.').pop()?.toLowerCase();
  try {
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
      for (const cfg of [
        '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', '.eslintrc.mjs',
        '.eslintrc.yml', '.eslintrc', 'eslint.config.js', 'eslint.config.mjs',
      ]) {
        try {
          await fs.access(path.join(workdir, cfg));
          return `npx eslint --no-error-on-unmatched-pattern "${relPath}" 2>&1`;
        } catch { /* keep scanning */ }
      }
    }
    if (ext === 'py') return `python -m py_compile "${relPath}" 2>&1`;
    if (ext === 'go') return `gofmt -l "${relPath}" 2>&1`;
    if (ext === 'rs') return `rustfmt --check "${relPath}" 2>&1`;
  } catch {
    // No lint config found — skip linting.
  }
  return null;
}

// Build the Show-details diff payload for an accepted edit. No diff is
// attached on reverts — the file's final state equals the original, so
// there is no change to review.
export function acceptedEditResult(
  toolName: string,
  relPath: string,
  originalContent: string,
  newContent: string,
  outputPreview: string,
  startMs: number,
): ToolResult {
  return {
    tool: toolName as ToolResult['tool'],
    title: relPath,
    outputPreview,
    durationMs: Date.now() - startMs,
    diff: buildEditDiff({ relPath, oldContent: originalContent, newContent }),
  };
}

// After an edit/multi_edit computes new content, write it, run the repo linter
// on the edited file, and revert ONLY if the edit introduced NEW lint errors.
// The before/after diff avoids reverting edits whose lint failures pre-existed.
// This function owns the file write so callers must not pre-write.
export async function lintAndMaybeRevert(
  workdir: string,
  relPath: string,
  originalContent: string,
  newContent: string,
  secrets: string[],
  startMs: number,
  toolName: string,
): Promise<ToolResult> {
  const lintCmd = await detectLintCommand(workdir, relPath);
  const absPath = jailPath(workdir, relPath);
  if (!lintCmd) {
    // No linter configured for this file type — still must persist the edit.
    // (Returning "edited" without writing silently dropped the change.)
    await fs.writeFile(absPath, newContent, 'utf8');
    return acceptedEditResult(
      toolName, relPath, originalContent, newContent,
      truncate(redactSecrets(`edited ${relPath}`, secrets)), startMs,
    );
  }
  // Write the NEW content first, then lint.
  await fs.writeFile(absPath, newContent, 'utf8');
  try {
    await execFileAsync('sh', ['-c', lintCmd], {
      cwd: workdir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    // Lint passed — accept.
    return acceptedEditResult(
      toolName, relPath, originalContent, newContent,
      truncate(redactSecrets(`edited ${relPath} (lint clean)`, secrets)), startMs,
    );
  } catch (err) {
    // Lint failed — check if these errors are NEW (weren't in the original).
    // Write original back and lint it to get baseline.
    await fs.writeFile(absPath, originalContent, 'utf8');
    let baselineErrors = '';
    try {
      await execFileAsync('sh', ['-c', lintCmd], {
        cwd: workdir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      });
      // Original is clean — so ALL errors are new.
    } catch (baselineErr) {
      const be = baselineErr as { stdout?: string; stderr?: string };
      baselineErrors = (be.stdout || '') + (be.stderr || '');
    }
    // Write new content back to capture the post-edit lint output.
    await fs.writeFile(absPath, newContent, 'utf8');
    const e = err as { stdout?: string; stderr?: string };
    const newLintOutput = (e.stdout || '') + (e.stderr || '');
    if (baselineErrors && baselineErrors.trim() === newLintOutput.trim()) {
      // Same errors as before — the edit introduced no new lint issues. Accept.
      return acceptedEditResult(
        toolName, relPath, originalContent, newContent,
        truncate(redactSecrets(`edited ${relPath}`, secrets)), startMs,
      );
    }
    // Genuinely new lint errors — revert.
    await fs.writeFile(absPath, originalContent, 'utf8');
    return {
      tool: toolName as ToolResult['tool'],
      title: relPath,
      outputPreview: truncate(redactSecrets(`edit reverted — new lint errors:\n${newLintOutput}`, secrets)),
      durationMs: Date.now() - startMs,
      error: `new lint errors after edit (reverted): ${newLintOutput.slice(0, 500)}`,
    };
  }
}
