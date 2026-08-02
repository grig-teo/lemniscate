// Edit-content helpers shared by edit-router.ts (the routing layer) and
// loop-tool-runner.ts (the tool dispatcher). Extracted from tools.ts to keep
// that module under the 300-line guard. Single source of truth for edit
// validation: search-found + exactly-one-match + literal $ handling.
import { jailPath, readFileTarget } from './tools.js';
import { checkpointEdit } from './edit-checkpoint.js';

/**
 * Read the file, run the caller's validation + content transform, and
 * checkpoint the pre-edit content for undo_edit. Does NOT write — the caller
 * (or verifyEditWithFallback) owns the write via lintAndMaybeRevert.
 */
export async function prepareEditContent(
  workdir: string,
  relPath: string,
  compute: (original: string) => string,
): Promise<{ originalContent: string; newContent: string }> {
  const absPath = jailPath(workdir, relPath);
  const originalContent = await readFileTarget(absPath, relPath, 'edit_file');
  const newContent = compute(originalContent);
  checkpointEdit(workdir, relPath, originalContent);
  return { originalContent, newContent };
}

/** Compute the result of an edit_file search/replace, with full validation. */
export function applySingleEdit(
  relPath: string,
  original: string,
  search: string,
  replace: string,
): string {
  if (!original.includes(search)) {
    const preview = original.split('\n').filter((l) => l.trim()).slice(0, 5).join('\n');
    throw new Error(`edit_file: search string not found in ${relPath}. First lines:\n${preview}`);
  }
  if (countOccurrences(original, search) !== 1) {
    throw new Error(`edit_file: expected exactly 1 match, found ${countOccurrences(original, search)} in ${relPath}`);
  }
  // Replacer function so $ patterns (e.g. `$&`, `$1`) in `replace` are literal.
  return original.replace(search, () => replace);
}

/** Compute the result of a multi_edit sequence, with full validation. */
export function applyMultiEdit(
  relPath: string,
  original: string,
  edits: { search: string; replace: string }[],
): string {
  let content = original;
  edits.forEach(({ search, replace }, i) => {
    if (!content.includes(search)) {
      throw new Error(`multi_edit: search string not found in ${relPath} (edit ${i + 1})`);
    }
    if (countOccurrences(content, search) !== 1) {
      throw new Error(`multi_edit: expected exactly 1 match for edit ${i + 1}, found ${countOccurrences(content, search)}`);
    }
    content = content.replace(search, () => replace);
  });
  return content;
}

function countOccurrences(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (haystack.match(new RegExp(escaped, 'g')) ?? []).length;
}
