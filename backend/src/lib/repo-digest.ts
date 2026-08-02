import { promises as fs } from 'node:fs';
import path from 'node:path';

import { git, logEvent } from './agent-git.js';
import {
  llmCall,
  TokenBudgetExceededError,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { buildFileTree, isKeyFile } from './repo-context.js';

// Repository context digest: an LLM-written architecture map of the default
// branch, stored on the Repository row and regenerated only when a run
// observes a new default HEAD. Every task prompt injects it, so the agent
// starts with repo knowledge instead of spending exploration turns (and
// tokens) rediscovering the same structure on every task.
//
// Generation reuses the run's own fresh clone (no extra clone) and costs one
// small LLM call per default-branch change — amortized across all tasks on
// the repo, it is far cheaper than per-task from-zero exploration.

const MAX_DIGEST_CHARS = 12_000;
const MAX_TREE_CHARS = 10_000;
const MAX_KEY_FILES = 25;
const MAX_KEY_FILE_CHARS = 3_000;
const MAX_INPUT_CHARS = 45_000;

export function digestIsFresh(digestSha: string | null, headSha: string): boolean {
  return digestSha !== null && digestSha === headSha;
}

/** Prepends the stored digest to a per-run repo context (no-op when absent). */
export function withRepoDigest(repoContext: string, digest: string | null | undefined): string {
  const trimmed = digest?.trim();
  return trimmed ? `# Repository digest (auto-generated)\n${trimmed}\n\n${repoContext}` : repoContext;
}

export interface DigestKeyFile {
  path: string;
  content: string;
}

export interface DigestInput {
  treeText: string;
  keyFiles: DigestKeyFile[];
}

// Collects the generation input from a workdir: the file tree plus the
// contents of key files (manifests, entry points, READMEs) — the same
// heuristics as the per-run repo-context builder, budgeted smaller.
export async function collectDigestInput(workdir: string): Promise<DigestInput> {
  const tree = await buildFileTree(workdir);
  const treeText = tree.join('\n').slice(0, MAX_TREE_CHARS);
  const keyFiles: DigestKeyFile[] = [];
  let total = treeText.length;
  for (const rel of tree) {
    if (keyFiles.length >= MAX_KEY_FILES || total >= MAX_INPUT_CHARS) break;
    if (!isKeyFile(rel)) continue;
    try {
      const raw = await fs.readFile(path.join(workdir, rel), 'utf8');
      const content = raw.slice(0, Math.min(MAX_KEY_FILE_CHARS, MAX_INPUT_CHARS - total));
      keyFiles.push({ path: rel, content });
      total += content.length;
    } catch {
      // Unreadable/non-UTF8 file — skip it.
    }
  }
  return { treeText, keyFiles };
}

export function buildDigestPrompt(fullName: string, input: DigestInput): string {
  const fileSections = input.keyFiles
    .map((file) => `## File: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    .join('\n\n');
  return [
    `Write a concise architecture digest for the repository ${fullName}. It will be injected into every future coding-agent task on this repo so the agent can skip from-zero exploration.`,
    '',
    'Reply with ONLY markdown, at most 200 lines, with exactly these sections:',
    '- **Purpose** — what the project is, in 1-2 sentences.',
    '- **Architecture map** — bullet list of the important directories/modules and what lives in each.',
    '- **Entry points & data flow** — where execution starts and how the pieces connect.',
    '- **Conventions** — naming, structure and style rules visible in the tree/manifests.',
    '- **Build & test commands** — the exact commands to install, build, test and lint.',
    '- **Gotchas** — non-obvious facts an agent must know (monorepo layout, generated files, size guards).',
    'Be concrete and terse; do not invent details that are not visible in the input.',
    '',
    `## File tree\n${input.treeText}`,
    '',
    fileSections,
  ].join('\n');
}

/**
 * Returns the repo's context digest, generating or refreshing it when the
 * workdir's HEAD (a fresh clone's default-branch tip) differs from the SHA
 * the stored digest was built at. Never fails the run: on any error the old
 * digest (possibly null) is returned — stale context beats a crashed task.
 * The token budget hard-stop is rethrown, matching generateBranchName.
 */
export async function ensureRepoDigest(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
): Promise<string | null> {
  const repo = task.repository;
  try {
    const headSha = (await git(['rev-parse', 'HEAD'], { cwd: workdir, taskId: task.id })).trim();
    if (repo.contextDigest && digestIsFresh(repo.contextDigestSha, headSha)) {
      return repo.contextDigest;
    }
    await logEvent(task.id, 'generating repository context digest');
    const input = await collectDigestInput(workdir);
    if (input.treeText.trim().length === 0) return repo.contextDigest;
    const content = await llmCall(rt, [
      { role: 'user', content: buildDigestPrompt(repo.fullName, input) },
    ]);
    const digest = content.slice(0, MAX_DIGEST_CHARS);
    await prisma.repository.update({
      where: { id: repo.id },
      data: { contextDigest: digest, contextDigestSha: headSha, contextDigestAt: new Date() },
    });
    // Keep the in-memory task in sync so this run's prompt injection sees it.
    repo.contextDigest = digest;
    repo.contextDigestSha = headSha;
    repo.contextDigestAt = new Date();
    await logEvent(
      task.id,
      `repository context digest ready (${digest.length} chars, sha ${headSha.slice(0, 7)})`,
    );
    return digest;
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) throw err;
    logger.warn({ err, repoId: repo.id }, 'repo digest generation failed; continuing without it');
    await logEvent(
      task.id,
      `context digest generation failed: ${(err as Error).message.slice(0, 200)} — continuing without it`,
    );
    return repo.contextDigest ?? null;
  }
}
