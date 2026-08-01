import { beforeEach, describe, expect, it, vi } from 'vitest';

// Core agent executor resolution (lib/agent-executor.ts): 'lemcore' is the
// only executor — hermes/internal were removed. The per-user override stored
// on User.agentExecutor wins when it names a live executor; stale values
// from removed executors ('hermes'/'internal') degrade to 'lemcore', as do
// failed user lookups (a failed lookup must never break a job).

const mocks = vi.hoisted(() => ({
  config: { AGENT_EXECUTOR: 'lemcore' as string },
  userFindUnique: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/lib/logger.js', () => ({
  logger: mocks.logger,
  createLogger: vi.fn(() => mocks.logger),
}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { user: { findUnique: mocks.userFindUnique } },
}));

import {
  AGENT_EXECUTORS,
  defaultAgentExecutor,
  parseAgentExecutor,
  resolveAgentExecutor,
} from '../src/lib/agent-executor.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.AGENT_EXECUTOR = 'lemcore';
  mocks.userFindUnique.mockResolvedValue({ agentExecutor: null });
});

describe('AGENT_EXECUTORS', () => {
  it('offers only lemcore (hermes/internal removed)', () => {
    expect(AGENT_EXECUTORS).toEqual(['lemcore']);
  });
});

describe('parseAgentExecutor', () => {
  it('accepts lemcore', () => {
    expect(parseAgentExecutor('lemcore')).toBe('lemcore');
  });

  it('rejects removed executors and unknown values', () => {
    expect(parseAgentExecutor('hermes')).toBeNull();
    expect(parseAgentExecutor('internal')).toBeNull();
    expect(parseAgentExecutor('codex')).toBeNull();
    expect(parseAgentExecutor('')).toBeNull();
    expect(parseAgentExecutor(null)).toBeNull();
    expect(parseAgentExecutor(undefined)).toBeNull();
  });
});

describe('defaultAgentExecutor', () => {
  it('returns the AGENT_EXECUTOR env value', () => {
    expect(defaultAgentExecutor()).toBe('lemcore');
  });

  it('falls back to lemcore when the env value is not a live executor', () => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    expect(defaultAgentExecutor()).toBe('lemcore');
  });
});

describe('resolveAgentExecutor', () => {
  it('returns the user override when a live executor is stored', async () => {
    mocks.userFindUnique.mockResolvedValue({ agentExecutor: 'lemcore' });
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { agentExecutor: true },
    });
  });

  it('degrades a stale per-user executor (hermes/internal) to lemcore', async () => {
    mocks.userFindUnique.mockResolvedValue({ agentExecutor: 'hermes' });
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
    mocks.userFindUnique.mockResolvedValue({ agentExecutor: 'internal' });
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
  });

  it('falls back to the env default when the user has no override', async () => {
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
  });

  it('falls back to the env default when the stored value is unknown', async () => {
    mocks.userFindUnique.mockResolvedValue({ agentExecutor: 'codex' });
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
  });

  it('falls back to the env default when the lookup fails (and warns)', async () => {
    mocks.userFindUnique.mockRejectedValue(new Error('db down'));
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });
});
