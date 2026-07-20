import { describe, expect, it, vi } from 'vitest';

// Locking tests for the BullMQ enqueue helpers. BullMQ and ioredis are mocked
// so no real Redis is contacted; we only assert what would be enqueued.

const mocks = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }));

vi.mock('bullmq', () => ({ Queue: class { add = mocks.add; } }));
vi.mock('ioredis', () => ({ Redis: vi.fn() }));

import { enqueueGenerateProposalsNow } from '../src/lib/proposal-scheduler.js';

describe('enqueueGenerateProposalsNow', () => {
  it('enqueues a one-shot generate-proposals job with a dedupe jobId', async () => {
    await enqueueGenerateProposalsNow('repo-1');
    expect(mocks.add).toHaveBeenCalledWith(
      'generate-proposals',
      { repositoryId: 'repo-1' },
      expect.objectContaining({ jobId: 'generate-proposals:repo-1' }),
    );
  });
});
