import { beforeEach, describe, expect, it, vi } from 'vitest';

// Core agent executor resolution (lib/agent-executor.ts): lemcore is the
// only agent. Values previously stored on User.agentExecutor ('hermes' /
// 'internal' from older deployments) are ignored — resolution always lands
// on lemcore, and a failed user lookup must never break a job.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

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
  mocks.userFindUnique.mockResolvedValue({ agentExecutor: null });
});

describe('AGENT_EXECUTORS', () => {
  it('offers lemcore only', () => {
    expect(AGENT_EXECUTORS).toEqual(['lemcore']);
  });
});

describe('parseAgentExecutor', () => {
  it('accepts lemcore', () => {
    expect(parseAgentExecutor('lemcore')).toBe('lemcore');
  });

  it('rejects the removed executors and unknown values', () => {
    expect(parseAgentExecutor('hermes')).toBeNull();
    expect(parseAgentExecutor('internal')).toBeNull();
    expect(parseAgentExecutor(null)).toBeNull();
    expect(parseAgentExecutor(undefined)).toBeNull();
    expect(parseAgentExecutor('codex')).toBeNull();
    expect(parseAgentExecutor('')).toBeNull();
  });
});

describe('defaultAgentExecutor', () => {
  it('returns lemcore', () => {
    expect(defaultAgentExecutor()).toBe('lemcore');
  });
});

describe('resolveAgentExecutor', () => {
  it('returns lemcore when the user has a lemcore override stored', async () => {
    mocks.userFindUnique.mockResolvedValue({ agentExecutor: 'lemcore' });
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { agentExecutor: true },
    });
  });

  it('returns lemcore when the user has no override', async () => {
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
  });

  it('returns lemcore when a removed executor is still stored', async () => {
    mocks.userFindUnique.mockResolvedValue({ agentExecutor: 'hermes' });
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
  });

  it('returns lemcore when the lookup fails (and warns)', async () => {
    mocks.userFindUnique.mockRejectedValue(new Error('db down'));
    await expect(resolveAgentExecutor('user-1')).resolves.toBe('lemcore');
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });
});
