import { beforeEach, describe, expect, it, vi } from 'vitest';

// Core agent executor resolution (lib/agent-executor.ts): the per-user
// override stored on User.agentExecutor (Settings → Agent) wins; otherwise
// the deployment default from the AGENT_EXECUTOR env var applies. A failed
// user lookup must never break a job — it falls back to the env default.

const mocks = vi.hoisted(() => ({
  config: { AGENT_EXECUTOR: 'hermes' as string },
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
  mocks.config.AGENT_EXECUTOR = 'hermes';
  mocks.userFindUnique.mockResolvedValue({ agentExecutor: null });
});

describe('AGENT_EXECUTORS', () => {
  it('offers exactly the hermes and internal options', () => {
    expect(AGENT_EXECUTORS).toEqual(['hermes', 'internal']);
  });
});

describe('parseAgentExecutor', () => {
  it('accepts the two known executors', () => {
    expect(parseAgentExecutor('hermes')).toBe('hermes');
    expect(parseAgentExecutor('internal')).toBe('internal');
  });

  it('rejects null, undefined, and unknown values', () => {
    expect(parseAgentExecutor(null)).toBeNull();
    expect(parseAgentExecutor(undefined)).toBeNull();
    expect(parseAgentExecutor('codex')).toBeNull();
    expect(parseAgentExecutor('')).toBeNull();
  });
});

describe('defaultAgentExecutor', () => {
  it('returns the AGENT_EXECUTOR env value', () => {
    mocks.config.AGENT_EXECUTOR = 'internal';
    expect(defaultAgentExecutor()).toBe('internal');
  });
});

describe('resolveAgentExecutor', () => {
  it('returns the user override when one is stored', async () => {
    mocks.userFindUnique.mockResolvedValue({ agentExecutor: 'internal' });
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('internal');
    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { agentExecutor: true },
    });
  });

  it('falls back to the env default when the user has no override', async () => {
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('hermes');
  });

  it('falls back to the env default when the stored value is unknown', async () => {
    mocks.userFindUnique.mockResolvedValue({ agentExecutor: 'codex' });
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('hermes');
  });

  it('falls back to the env default when the lookup fails (and warns)', async () => {
    mocks.userFindUnique.mockRejectedValue(new Error('db down'));
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('hermes');
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });
});
