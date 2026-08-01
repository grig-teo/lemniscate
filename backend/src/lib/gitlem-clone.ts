import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
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
  await git(['config', 'http.receivepack', 'false'], bareDir);
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
