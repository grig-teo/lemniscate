// Line-level unified diff builder for file edit/write tool results.
// Powers the agent console "Show details" view: every edit_file / write_file
// tool event carries a `diff` payload so users can review exactly what the
// agent added or removed. Size-guarded so huge files announce instead of
// computing multi-MB diffs, and binary content gets a notice, not garbage.
import { createTwoFilesPatch } from 'diff';

// Skip diff computation when either side exceeds this many chars — the
// resulting diff would be unreadable in the console and slow to compute.
export const DIFF_MAX_INPUT_CHARS = 500_000;
// Cap the emitted unified diff; longer diffs are truncated with a marker.
export const DIFF_MAX_OUTPUT_CHARS = 20_000;

export interface EditDiffInput {
  relPath: string;
  /** Previous file content, or null when the file did not exist. */
  oldContent: string | null;
  newContent: string;
}

// NUL byte is a reliable signal of non-text content.
function looksBinary(content: string): boolean {
  return content.includes('\u0000');
}

function truncateDiff(diff: string): string {
  if (diff.length <= DIFF_MAX_OUTPUT_CHARS) return diff;
  return `${diff.slice(0, DIFF_MAX_OUTPUT_CHARS)}\n… [diff truncated at ${DIFF_MAX_OUTPUT_CHARS} chars] …`;
}

/**
 * Build a unified diff (a/ b/ git-style paths) between the before/after
 * content of a file. Handles new files (--- /dev/null), identical content
 * ("no changes"), oversized inputs ("diff not available"), binary content
 * ("binary file changed"), and oversized outputs (truncated with a marker).
 */
export function buildEditDiff(input: EditDiffInput): string {
  const oldText = input.oldContent ?? '';
  if (looksBinary(oldText) || looksBinary(input.newContent)) {
    return `binary file changed: ${input.relPath} (no text diff available)`;
  }
  if (
    oldText.length > DIFF_MAX_INPUT_CHARS ||
    input.newContent.length > DIFF_MAX_INPUT_CHARS
  ) {
    return `diff not available for ${input.relPath}: file too large`;
  }
  if (oldText === input.newContent) {
    return `no changes in ${input.relPath} (content identical)`;
  }
  const oldName = input.oldContent === null ? '/dev/null' : `a/${input.relPath}`;
  const patch = createTwoFilesPatch(
    oldName,
    `b/${input.relPath}`,
    oldText,
    input.newContent,
    '',
    '',
  );
  return truncateDiff(patch);
}
