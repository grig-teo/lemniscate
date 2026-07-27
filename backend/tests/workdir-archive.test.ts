import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

// Isolated module state for these tests: config + minio + task-events are all
// mocked so the suite never touches the network, the DB, or real env parsing.

const minio = vi.hoisted(() => ({
  getMinioBucket: vi.fn(),
  fPutObject: vi.fn(),
}));
const events = vi.hoisted(() => ({ publishTaskEvent: vi.fn() }));

vi.mock('../src/lib/minio-client.js', () => ({ getMinioBucket: minio.getMinioBucket }));
vi.mock('../src/lib/task-events.js', () => ({ publishTaskEvent: events.publishTaskEvent }));
vi.mock('../src/config.js', () => ({
  config: {
    WORKDIR_ARCHIVE_ENABLED: true,
    WORKDIR_ARCHIVE_BUCKET: 'lemniscate-workdir-archives',
    // 1 MB cap — small fixtures stay under it; the skip test builds >1 MB.
    WORKDIR_ARCHIVE_MAX_MB: 1,
  },
}));

import { config } from '../src/config.js';
import {
  archiveObjectKey,
  archiveWorkdirToMinio,
  buildTarExcludes,
  TAR_EXCLUDES,
  WORKDIR_ARCHIVE_BUCKET,
  workdirSizeBytes,
} from '../src/lib/workdir-archive.js';

// Lists the entries of a tar.gz the archive produced. tar is a real
// subprocess (BusyBox/GNU both support --exclude) so the exclude behavior is
// exercised end-to-end on the fixture.
async function tarEntries(filePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('tar', ['-tzf', filePath]);
  return stdout.split('\n').filter(Boolean);
}

// fPutObject mock that snapshots the staging tarball into a temp file before
// the archive's `finally` deletes the staging dir. Returns the kept path.
async function captureTarball(): Promise<() => string> {
  let path = '';
  minio.fPutObject.mockImplementation(async (_b: string, _k: string, filePath: string) => {
    const keep = await mkdtemp(join(tmpdir(), 'workdir-archive-tar-'));
    const dest = join(keep, 'workdir.tar.gz');
    await writeFile(dest, await readFile(filePath));
    path = dest;
  });
  return () => path;
}

describe('archiveObjectKey', () => {
  it('builds a dated tar.gz key under workdirs/ from the workdir name', () => {
    const key = archiveObjectKey(
      '/tmp/lemniscate-repos/task-42',
      new Date('2025-01-02T03:04:05.006Z'),
    );
    expect(key).toBe('workdirs/task-42-2025-01-02T03-04-05-006Z.tar.gz');
  });
});

describe('TAR_EXCLUDES / buildTarExcludes', () => {
  it('lists .git, node_modules, and common build outputs', () => {
    expect(TAR_EXCLUDES).toContain('.git');
    expect(TAR_EXCLUDES).toContain('node_modules');
    expect(TAR_EXCLUDES).toContain('dist');
    expect(TAR_EXCLUDES).toContain('build');
    expect(TAR_EXCLUDES).toContain('target');
  });

  it('emits alternating --exclude <name> args for tar', () => {
    const args = buildTarExcludes();
    expect(args[0]).toBe('--exclude');
    expect(args[1]).toBe(TAR_EXCLUDES[0]);
    expect(args.length).toBe(TAR_EXCLUDES.length * 2);
  });
});

describe('workdirSizeBytes', () => {
  it('counts working-tree files but skips .git and node_modules subtrees', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'workdir-size-'));
    try {
      await mkdir(join(workdir, '.git', 'objects'), { recursive: true });
      await writeFile(join(workdir, '.git', 'objects', 'pack'), 'x'.repeat(50));
      await mkdir(join(workdir, 'node_modules', 'foo'), { recursive: true });
      await writeFile(join(workdir, 'node_modules', 'foo', 'lib'), 'y'.repeat(50));
      await mkdir(join(workdir, 'src'), { recursive: true });
      await writeFile(join(workdir, 'src', 'app.ts'), 'z'.repeat(30));
      const bytes = await workdirSizeBytes(workdir);
      expect(bytes).toBe(30);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('does not descend into nested excluded names either', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'workdir-size-nested-'));
    try {
      await mkdir(join(workdir, 'pkg', 'node_modules'), { recursive: true });
      await writeFile(join(workdir, 'pkg', 'node_modules', 'x'), 'x'.repeat(40));
      await writeFile(join(workdir, 'pkg', 'main.ts'), 'a');
      expect(await workdirSizeBytes(workdir)).toBe(1);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});

describe('archiveWorkdirToMinio', () => {
  let workdir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    minio.getMinioBucket.mockResolvedValue({ client: { fPutObject: minio.fPutObject } });
    minio.fPutObject.mockReset();
    minio.fPutObject.mockResolvedValue(undefined);
    events.publishTaskEvent.mockReset();
    events.publishTaskEvent.mockResolvedValue(undefined);
    workdir = await mkdtemp(join(tmpdir(), 'workdir-archive-test-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('excludes .git, node_modules, and build outputs from the uploaded tar', async () => {
    await mkdir(join(workdir, '.git', 'objects'), { recursive: true });
    await writeFile(join(workdir, '.git', 'objects', 'pack'), 'git-pack');
    await mkdir(join(workdir, 'node_modules', 'foo'), { recursive: true });
    await writeFile(join(workdir, 'node_modules', 'foo', 'lib'), 'nm-lib');
    await mkdir(join(workdir, 'dist'), { recursive: true });
    await writeFile(join(workdir, 'dist', 'out.js'), 'dist-out');
    await mkdir(join(workdir, 'src'), { recursive: true });
    await writeFile(join(workdir, 'src', 'app.ts'), 'app');

    const getTarball = await captureTarball();
    await archiveWorkdirToMinio(workdir, 'task-1');

    expect(minio.fPutObject).toHaveBeenCalledTimes(1);
    const tarballPath = getTarball();
    expect(tarballPath).toMatch(/\.tar\.gz$/);
    const entries = await tarEntries(tarballPath);
    for (const entry of entries) {
      expect(entry).not.toMatch(/(^|\/)\.git(\/|$)/);
      expect(entry).not.toMatch(/(^|\/)node_modules(\/|$)/);
      expect(entry).not.toMatch(/(^|\/)dist(\/|$)/);
    }
    expect(entries.some((e) => e.endsWith('app.ts'))).toBe(true);
  });

  it('uploads a tarball of the workdir into the archive bucket', async () => {
    await writeFile(join(workdir, 'hello.txt'), 'hello');
    await archiveWorkdirToMinio(workdir);
    expect(minio.getMinioBucket).toHaveBeenCalledWith(WORKDIR_ARCHIVE_BUCKET);
    expect(minio.fPutObject).toHaveBeenCalledTimes(1);
    const [bucket, key, filePath] = minio.fPutObject.mock.calls[0]!;
    expect(bucket).toBe(WORKDIR_ARCHIVE_BUCKET);
    expect(key).toMatch(/^workdirs\/workdir-archive-test-.+\.tar\.gz$/);
    expect(filePath).toMatch(/\.tar\.gz$/);
  });

  it('leaves the workdir in place (archival only, no deletion)', async () => {
    await writeFile(join(workdir, 'hello.txt'), 'hello');
    await archiveWorkdirToMinio(workdir);
    const { stat } = await import('node:fs/promises');
    await expect(stat(join(workdir, 'hello.txt'))).resolves.toBeTruthy();
  });

  it('is a no-op when MinIO is not configured', async () => {
    minio.getMinioBucket.mockResolvedValue(null);
    await writeFile(join(workdir, 'hello.txt'), 'hello');
    await archiveWorkdirToMinio(workdir);
    expect(minio.fPutObject).not.toHaveBeenCalled();
  });

  it('never rejects, even when the upload fails', async () => {
    minio.fPutObject.mockRejectedValue(new Error('minio down'));
    await writeFile(join(workdir, 'hello.txt'), 'hello');
    await expect(archiveWorkdirToMinio(workdir)).resolves.toBeUndefined();
  });

  it('never rejects for a missing workdir', async () => {
    await expect(
      archiveWorkdirToMinio(join(workdir, 'does-not-exist')),
    ).resolves.toBeUndefined();
    expect(minio.fPutObject).not.toHaveBeenCalled();
  });

  it('skips archiving and records an archive_skipped_size event when the workdir exceeds the cap', async () => {
    // Cap is 1 MB (mocked config); write ~2 MB of working-tree files.
    const big = 'x'.repeat(2 * 1024 * 1024);
    await mkdir(join(workdir, 'src'), { recursive: true });
    await writeFile(join(workdir, 'src', 'big.bin'), big);

    await archiveWorkdirToMinio(workdir, 'task-9');

    expect(minio.fPutObject).not.toHaveBeenCalled();
    expect(events.publishTaskEvent).toHaveBeenCalledTimes(1);
    const [taskId, kind, payload] = events.publishTaskEvent.mock.calls[0]!;
    expect(taskId).toBe('task-9');
    expect(kind).toBe('log');
    expect((payload as { line: string }).line).toContain('archive_skipped_size');
  });

  it('cleanup still succeeds (no throw) when the workdir is over the cap', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    await mkdir(join(workdir, 'src'), { recursive: true });
    await writeFile(join(workdir, 'src', 'big.bin'), big);
    await expect(archiveWorkdirToMinio(workdir)).resolves.toBeUndefined();
  });

  it('is a no-op when WORKDIR_ARCHIVE_ENABLED=false (no tar, no MinIO call)', async () => {
    const original = config.WORKDIR_ARCHIVE_ENABLED;
    config.WORKDIR_ARCHIVE_ENABLED = false;
    try {
      await writeFile(join(workdir, 'hello.txt'), 'hello');
      await archiveWorkdirToMinio(workdir, 'task-disabled');
      expect(minio.getMinioBucket).not.toHaveBeenCalled();
      expect(minio.fPutObject).not.toHaveBeenCalled();
      expect(events.publishTaskEvent).not.toHaveBeenCalled();
    } finally {
      config.WORKDIR_ARCHIVE_ENABLED = original;
    }
  });
});