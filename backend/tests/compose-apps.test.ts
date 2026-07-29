import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPOSE_FILE_NAMES,
  buildComposeDownArgs,
  buildComposeUpArgs,
  composeProjectName,
  detectComposeFile,
  writeComposeEnvFile,
} from '../src/lib/deploy/compose-apps.js';

// Pure helper tests for the docker-compose deploy path. The exec wrappers
// (composeUp/composeDown) shell out to the `docker` CLI and are not exercised
// here — only the candidates detection, project naming, argv builders, and
// env-file writer, all of which are side-effect-free (modulo the temp dir).

describe('COMPOSE_FILE_NAMES', () => {
  it('lists the standard docker/compose v2 file names', () => {
    expect(COMPOSE_FILE_NAMES).toContain('docker-compose.yml');
    expect(COMPOSE_FILE_NAMES).toContain('docker-compose.yaml');
    expect(COMPOSE_FILE_NAMES).toContain('compose.yml');
    expect(COMPOSE_FILE_NAMES).toContain('compose.yaml');
  });
});

describe('detectComposeFile', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lemniscate-compose-'));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  web:\n    image: alpine\n');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no compose file is at the root', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'lemniscate-empty-'));
    try {
      expect(await detectComposeFile(empty)).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('detects docker-compose.yml', async () => {
    expect(await detectComposeFile(dir)).toBe('docker-compose.yml');
  });

  it('prefers docker-compose.yml over compose.yaml when both are present', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'lemniscate-both-'));
    try {
      await writeFile(join(sub, 'compose.yaml'), 'x: 1\n');
      await writeFile(join(sub, 'docker-compose.yml'), 'x: 2\n');
      expect(await detectComposeFile(sub)).toBe('docker-compose.yml');
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  });

  it('detects compose.yaml when docker-compose.* is absent', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'lemniscate-yaml-'));
    try {
      await writeFile(join(sub, 'compose.yaml'), 'x: 1\n');
      expect(await detectComposeFile(sub)).toBe('compose.yaml');
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  });

  it('returns null when only a similarly-named but unsupported file exists', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'lemniscate-none-'));
    try {
      await writeFile(join(sub, 'docker-compose.yml.txt'), 'fake\n');
      expect(await detectComposeFile(sub)).toBeNull();
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  });
});

describe('composeProjectName', () => {
  it('produces a deterministic, lowercase, docker-compose-valid project name', () => {
    expect(composeProjectName('svc-abc123', 'abcdef1234567890')).toBe('lemniscate-svc-abc123-abcdef12');
  });

  it('keeps the same name for the same inputs (idempotent)', () => {
    expect(composeProjectName('svc-1', 'sha-x')).toBe(composeProjectName('svc-1', 'sha-x'));
  });
});

describe('buildComposeUpArgs', () => {
  it('targets the project, file, and env file with up -d --build --wait', () => {
    expect(buildComposeUpArgs('proj-1', 'docker-compose.yml', '/tmp/.lemniscate.env')).toEqual([
      'compose',
      '-p', 'proj-1',
      '-f', 'docker-compose.yml',
      '--env-file', '/tmp/.lemniscate.env',
      'up',
      '-d',
      '--build',
      '--wait',
    ]);
  });

  it('never embeds secrets in the argv (env file path only)', () => {
    const args = buildComposeUpArgs('p', 'compose.yaml', '/tmp/env');
    expect(args.some((a) => a.includes('supersecret'))).toBe(false);
  });
});

describe('buildComposeDownArgs', () => {
  it('targets the project with down --remove-orphans -v', () => {
    expect(buildComposeDownArgs('proj-1')).toEqual([
      'compose',
      '-p', 'proj-1',
      'down',
      '--remove-orphans',
      '-v',
    ]);
  });
});

describe('writeComposeEnvFile', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lemniscate-env-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a dotenv file under .lemniscate.env with KEY=value lines', async () => {
    const path = await writeComposeEnvFile(dir, { FOO: 'bar', BAZ: 'qux with space' });
    expect(path).toBe(join(dir, '.lemniscate.env'));
    const content = await readFile(path, 'utf8');
    expect(content).toContain('FOO=bar');
    expect(content).toContain('BAZ=qux with space');
  });

  it('creates the file even for an empty env map', async () => {
    const path = await writeComposeEnvFile(dir, {});
    const s = await stat(path);
    expect(s.isFile()).toBe(true);
  });
});