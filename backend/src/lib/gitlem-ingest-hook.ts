// post-receive hook entrypoint for gitlem bare repos. Invoked by the hook
// script written in gitlem-clone.ts as:
//
//   node <dist>/lib/gitlem-ingest-hook.js <repoId> <bareDir>
//
// Reads the pushed branch trees out of the bare repo and writes them into the
// repo's JSON doc (the durable source of truth), then invalidates the
// in-memory materialization cache so the next clone reflects the push. Exits
// non-zero only on an unexpected error — a failed doc write is logged and
// swallowed so the push itself still succeeds (the objects are in the bare
// repo; the doc will catch up on the next materialization).
import { ingestPushedRefs, invalidateGitlemCloneCache } from './gitlem-ingest.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const [, , repoIdArg, bareDirArg] = process.argv;
  if (!repoIdArg || !bareDirArg) {
    process.stderr.write('gitlem-ingest-hook: usage: node gitlem-ingest-hook.js <repoId> <bareDir>\n');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await ingestPushedRefs(repoIdArg, bareDirArg);
    invalidateGitlemCloneCache(repoIdArg);
    logger.info(
      { repoId: repoIdArg, ...result },
      'gitlem-ingest-hook: ingested pushed refs into the repo doc',
    );
  } catch (err) {
    // Never fail the push because the doc write threw — the git objects are
    // already in the bare repo and a later materialization reconciles.
    logger.error({ repoId: repoIdArg, err }, 'gitlem-ingest-hook: ingest failed (push still ok)');
  }
}

void main();
