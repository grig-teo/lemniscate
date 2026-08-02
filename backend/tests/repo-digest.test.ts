import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskWithRepo } from '../src/lib/agent-runtime.js';

// Locking tests for the repo context digest (lib/repo-digest.ts): freshness
// by default-branch SHA, prompt/input building, and the ensure flow that
// regenerates only when HEAD moved and never crashes the run on failure.
const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  llmCall: vi.fn(),
  repoUpdate: vi.fn(),
}));

vi.mock('../src/lib/agent-git.js', () => ({
  git: (...a: unknown[]) => mocks.git(...a),
  logEvent: async () => undefined,
}));
vi.mock('../src/lib/agent-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agent-runtime.js')>()),
  llmCall: (...a: unknown[]) => mocks.llmCall(...a),
}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { repository: { update: (...a: unknown[]) => mocks.repoUpdate(...a) } },
}));

import {
  buildDigestPrompt,
  collectDigestInput,
  digestIsFresh,
  ensureRepoDigest,
} from '../src/lib/repo-digest.js';

function fakeTask(digest: string | null, sha: string | null): TaskWithRepo {
  return {
    id: 't1',
    repository: {
      id: 'r1',
      fullName: 'alice/demo',
      contextDigest: digest,
      contextDigestSha: sha,
      contextDigestAt: null,
    },
  } as unknown as TaskWithRepo;
}

const fakeRt = { cfg: { contextWindow: 32_000 } } as never;

describe('digestIsFresh', () => {
  it('is fresh only when a stored SHA matches HEAD', () => {
    expect(digestIsFresh('abc', 'abc')).toBe(true);
    expect(digestIsFresh('abc', 'def')).toBe(false);
    expect(digestIsFresh(null, 'abc')).toBe(false);
  });
});

describe('collectDigestInput', () => {
  let workdir: string;
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'repo-digest-'));
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('collects the tree and key files, skipping node_modules', async () => {
    await mkdir(path.join(workdir, 'src'), { recursive: true });
    await mkdir(path.join(workdir, 'node_modules', 'junk'), { recursive: true });
    await writeFile(path.join(workdir, 'package.json'), '{"name":"demo"}');
    await writeFile(path.join(workdir, 'src', 'index.ts'), 'export const x = 1;');
    await writeFile(path.join(workdir, 'node_modules', 'junk', 'package.json'), '{}');
    const input = await collectDigestInput(workdir);
    expect(input.treeText).toContain('src/index.ts');
    expect(input.treeText).not.toContain('node_modules');
    expect(input.keyFiles.map((f) => f.path)).toEqual(['package.json', 'src/index.ts']);
  });
});

describe('buildDigestPrompt', () => {
  it('includes the repo name, tree and key-file contents with the section contract', () => {
    const prompt = buildDigestPrompt('alice/demo', {
      treeText: 'src/index.ts',
      keyFiles: [{ path: 'package.json', content: '{"name":"demo"}' }],
    });
    expect(prompt).toContain('alice/demo');
    expect(prompt).toContain('Architecture map');
    expect(prompt).toContain('Build & test commands');
    expect(prompt).toContain('src/index.ts');
    expect(prompt).toContain('{"name":"demo"}');
  });
});

describe('ensureRepoDigest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored digest without an LLM call when the SHA is fresh', async () => {
    mocks.git.mockResolvedValue('sha-fresh\n');
    const task = fakeTask('existing digest', 'sha-fresh');
    const result = await ensureRepoDigest(task, fakeRt, '/tmp/unused');
    expect(result).toBe('existing digest');
    expect(mocks.llmCall).not.toHaveBeenCalled();
    expect(mocks.repoUpdate).not.toHaveBeenCalled();
  });

  it('regenerates when HEAD moved, persists and updates the in-memory task', async () => {
    mocks.git.mockResolvedValue('sha-new\n');
    mocks.llmCall.mockResolvedValue('fresh digest');
    mocks.repoUpdate.mockResolvedValue({});
    const workdir = await mkdtemp(path.join(tmpdir(), 'repo-digest-'));
    try {
      await writeFile(path.join(workdir, 'package.json'), '{"name":"demo"}');
      const task = fakeTask('stale digest', 'sha-old');
      const result = await ensureRepoDigest(task, fakeRt, workdir);
      expect(result).toBe('fresh digest');
      expect(mocks.llmCall).toHaveBeenCalledTimes(1);
      expect(mocks.repoUpdate).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: expect.objectContaining({
          contextDigest: 'fresh digest',
          contextDigestSha: 'sha-new',
        }),
      });
      expect(task.repository.contextDigest).toBe('fresh digest');
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('falls back to the stale digest when generation fails', async () => {
    mocks.git.mockResolvedValue('sha-new\n');
    mocks.llmCall.mockRejectedValue(new Error('provider down'));
    const workdir = await mkdtemp(path.join(tmpdir(), 'repo-digest-'));
    try {
      await writeFile(path.join(workdir, 'package.json'), '{"name":"demo"}');
      const task = fakeTask('stale digest', 'sha-old');
      await expect(ensureRepoDigest(task, fakeRt, workdir)).resolves.toBe('stale digest');
      expect(mocks.repoUpdate).not.toHaveBeenCalled();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
