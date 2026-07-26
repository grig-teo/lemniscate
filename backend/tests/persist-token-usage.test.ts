import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  taskUpdate: vi.fn(),
  publishTaskEvent: vi.fn(),
  archiveWorkdirToMinio: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { task: { update: mocks.taskUpdate } },
}));
vi.mock('../src/lib/task-events.js', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}));
vi.mock('../src/lib/workdir-archive.js', () => ({
  archiveWorkdirToMinio: mocks.archiveWorkdirToMinio,
}));

import { persistTokenUsage } from '../src/lib/agent-git.js';

// persistTokenUsage stores the cumulative total; when the runtime's
// prompt/completion split is available it is persisted alongside (null-split
// legacy rows keep their null split when no split is passed).

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskUpdate.mockResolvedValue({});
});

describe('persistTokenUsage', () => {
  it('writes the total together with the prompt/completion split', async () => {
    await persistTokenUsage('task-1', 1500, { promptTokens: 1000, completionTokens: 500 });
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { llmTokensUsed: 1500, llmPromptTokens: 1000, llmCompletionTokens: 500 },
    });
  });

  it('writes only the total when no split is available', async () => {
    await persistTokenUsage('task-1', 1500);
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { llmTokensUsed: 1500 },
    });
  });

  it('swallows database errors (best-effort bookkeeping)', async () => {
    mocks.taskUpdate.mockRejectedValue(new Error('db down'));
    await expect(persistTokenUsage('task-1', 1)).resolves.toBeUndefined();
  });
});
