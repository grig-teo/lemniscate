import fs from 'node:fs/promises';
import path from 'node:path';

// Folder-tree listing of a cloned repository workdir: directories only (no
// files), used by GET /api/repositories/:id/folders to offer AGENTS.md
// per-folder assignment in the UI.

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const MAX_DEPTH = 6;
export const FOLDER_LIST_CAP = 300;

// Normalizes raw relative dir paths: '/'-prefixed, sorted, git/module
// internals dropped, root always first, capped at `cap` folders.
export function normalizeFolderPaths(paths: string[], cap = FOLDER_LIST_CAP): string[] {
  const folders = new Set<string>();
  for (const raw of paths) {
    const clean = raw.replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    if (clean === '') continue;
    const first = clean.split('/')[0] ?? clean;
    if (SKIPPED_DIRS.has(first)) continue;
    if (folders.size >= cap) break;
    folders.add(`/${clean}`);
  }
  return ['/', ...[...folders].sort()];
}

// Recursive directory walk of the workdir (depth-limited, symlink-blind).
export async function listWorkdirFolders(workdir: string, cap = FOLDER_LIST_CAP): Promise<string[]> {
  const paths: string[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (paths.length >= cap || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      paths.push(childRel);
      await walk(path.join(dir, entry.name), childRel, depth + 1);
    }
  }
  await walk(workdir, '', 0);
  return normalizeFolderPaths(paths, cap);
}
