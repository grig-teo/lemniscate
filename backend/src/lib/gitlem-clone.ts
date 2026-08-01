import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseGitlemDoc, type GitlemRepoDoc } from './gitlem-store.js';
import { prisma } from './prisma.js';

// Turns gitlem's JSON document store into a real git repository so
// `git clone <cloneUrl>` actually works: each branch's file tree is written
// to a temp work dir and committed, then `git clone` builds the advertised
// repo on disk and `git http-backend` serves the smart-HTTP protocol from
// it. Materialized clones are cached for TTL_MS and rebuilt when the doc
// changes (the cache compares the stored doc string).

const execFileAsync = promisify(execFile);
const TTL_MS = 10 * 60 * 1000;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'gitlem',
  GIT_AUTHOR_EMAIL: 'gitlem@lemniscate.local',
  GIT_COMMITTER_NAME: 'gitlem',
  GIT_COMMITTER_EMAIL: 'gitlem@lemniscate.local',
};

interface CacheEntry {
  dir: string;
  docHash: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test hook: drop the whole materialization cache. */
export function resetGitlemCloneCache(): void {
  cache.clear();
}

/**
 * Drop one repo's cached bare clone. Called by the post-receive hook after a
 * push ingests new refs into the doc: the cache entry now lags the doc (and
 * its bare dir holds the freshly-pushed objects but not a hook yet), so the
 * next materialization rebuilds from the authoritative doc.
 */
export function invalidateGitlemCloneCache(repoId: string): void {
  const entry = cache.get(repoId);
  if (!entry) return;
  cache.delete(repoId);
  // Best-effort cleanup of the stale bare dir; the next clone rebuilds it.
  void rm(dirname(entry.dir), { recursive: true, force: true }).catch(() => undefined);
}

async function git(args: string[], cwd?: string): Promise<void> {
  await execFileAsync('git', args, { cwd, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });
}

// Doc mutation routes rewrite the whole JSON column, so its content hash is
// a cheap "did anything change" signal for cache invalidation.
function hashDoc(doc: string): string {
  let hash = 0;
  for (let i = 0; i < doc.length; i += 1) {
    hash = (hash * 31 + doc.charCodeAt(i)) | 0;
  }
  return String(hash);
}

async function writeTree(workDir: string, files: { path: string; content: string }[]): Promise<void> {
  for (const file of files) {
    const target = normalize(join(workDir, file.path));
    // Path traversal guard: resolve relative to the work dir, then require the
    // resolved target to stay inside it. A bare startsWith(workDir) check is
    // unsound — '/tmp/x/work-evil' starts with '/tmp/x/work' — so compare via
    // path.relative(), which yields '..' for anything escaping the work dir.
    const rel = relative(workDir, target);
    if (isAbsolute(rel) || rel.startsWith('..')) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

async function commitBranch(workDir: string, branch: { name: string; files: { path: string; content: string }[] }): Promise<void> {
  await git(['checkout', '--orphan', `doc-${branch.name}`], workDir);
  await git(['rm', '-rf', '--ignore-unmatch', '.'], workDir);
  await writeTree(workDir, branch.files);
  await git(['add', '-A'], workDir);
  await git(['commit', '--allow-empty', '-m', `gitlem: snapshot of ${branch.name}`], workDir);
}

async function materializeDoc(workDir: string, doc: GitlemRepoDoc, defaultBranch: string): Promise<void> {
  await git(['init', '-b', defaultBranch], workDir);
  for (const branch of doc.branches) {
    await commitBranch(workDir, branch);
  }
  // The initial branch exists only after its first commit; point HEAD's
  // branch at the default branch's snapshot (fall back to the first branch,
  // or leave an empty tree for empty repos).
  const target = doc.branches.find((b) => b.name === defaultBranch)?.name ?? doc.branches[0]?.name;
  if (target) {
    await git(['checkout', `doc-${target}`], workDir);
    await git(['checkout', '-B', defaultBranch], workDir);
    // checkout -B copied the snapshot onto the real name; drop the scaffold
    // so the clone does not advertise a stray doc-<target> branch.
    await git(['branch', '-D', `doc-${target}`], workDir);
  }
  // Rename the remaining doc-<name> branches so the clone advertises the
  // real gitlem branch names (doc-main becomes main above).
  for (const branch of doc.branches) {
    if (branch.name !== target) {
      await git(['branch', '-m', `doc-${branch.name}`, branch.name], workDir);
    }
  }
}

// Absolute path to the compiled post-receive hook entrypoint. Resolved from
// this source module's location so it works in dev (src → sibling dist) and in
// the container (the app runs from /app/dist). gitlem-ingest-hook.ts is built
// alongside this file, so its dist path mirrors this module's.
function hookEntrypointPath(): string {
  // import.meta.url = file:///<dist>/lib/gitlem-clone.js (prod) or the src file (dev w/ tsx).
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), 'gitlem-ingest-hook.js');
}

// Writes a post-receive hook that ingests a push into the repo's JSON doc.
// git http-backend runs the hook with GIT_DIR set to the bare repo, so $PWD is
// the bare dir; the repo id is stashed in a file the hook reads (cleaner than
// embedding it in argv where shell escaping matters).
async function writeReceiveHook(bareDir: string, repoId: string): Promise<void> {
  const entrypoint = hookEntrypointPath();
  await writeFile(join(bareDir, 'LEMNISCATE_REPO_ID'), repoId, 'utf8');
  const script = [
    '#!/bin/sh',
    '# Auto-generated by lemniscate — ingests a git push into the gitlem doc.',
    'REPO_ID=$(cat "$PWD/LEMNISCATE_REPO_ID" 2>/dev/null)',
    'if [ -z "$REPO_ID" ]; then exit 0; fi',
    `exec node "${entrypoint}" "$REPO_ID" "$PWD"`,
    '',
  ].join('\n');
  const hookPath = join(bareDir, 'hooks', 'post-receive');
  await writeFile(hookPath, script, 'utf8');
  await chmod(hookPath, 0o755);
}

async function buildClone(repoId: string, doc: string, defaultBranch: string): Promise<CacheEntry> {
  const base = await mkdtemp(join(tmpdir(), 'gitlem-clone-'));
  const workDir = join(base, 'work');
  await mkdir(workDir);
  await materializeDoc(workDir, parseGitlemDoc(doc), defaultBranch);
  const bareDir = join(base, 'repo.git');
  // --bare: a plain clone lands branch refs under refs/remotes/origin/* and
  // downstream clones (and git http-backend) would only see the default
  // branch; --bare promotes every branch to refs/heads/*.
  await git(['clone', '--quiet', '--bare', workDir, bareDir]);
  // receive-pack is ON: the agent commits and pushes task branches via real
  // git. A post-receive hook ingests the pushed refs back into the JSON doc
  // (the durable source of truth), so the next materialization reflects them.
  await git(['config', 'http.receivepack', 'true'], bareDir);
  await writeReceiveHook(bareDir, repoId);
  return { dir: bareDir, docHash: hashDoc(doc), expiresAt: Date.now() + TTL_MS };
}

async function cachedClone(repoId: string, doc: string, defaultBranch: string): Promise<string> {
  const entry = cache.get(repoId);
  if (entry && entry.docHash === hashDoc(doc) && entry.expiresAt > Date.now()) {
    return entry.dir;
  }
  const fresh = await buildClone(repoId, doc, defaultBranch);
  cache.set(repoId, fresh);
  // Drop the just-built work dir (only the bare repo.git is served) and, when
  // this rebuild supersedes an older entry, its whole base dir so stale clones
  // don't accumulate on disk across doc changes. The superseded entry's base
  // is awaited so callers can rely on the old clone being gone.
  void rm(join(fresh.dir, '..', 'work'), { recursive: true, force: true }).catch(() => undefined);
  if (entry) {
    await rm(dirname(entry.dir), { recursive: true, force: true }).catch(() => undefined);
  }
  return fresh.dir;
}

/**
 * Resolve '<username>/<repo>' to an on-disk clone of its document state,
 * ready to be served by `git http-backend`. Returns null when the repo does
 * not exist.
 */
export async function materializeGitlemRepo(
  username: string,
  repoName: string,
): Promise<string | null> {
  const account = await prisma.gitlemUser.findUnique({ where: { username } });
  if (!account) return null;
  const repo = await prisma.gitlemRepository.findUnique({
    where: { ownerId_name: { ownerId: account.id, name: repoName } },
  });
  if (!repo) return null;
  return cachedClone(repo.id, repo.doc, repo.defaultBranch);
}
