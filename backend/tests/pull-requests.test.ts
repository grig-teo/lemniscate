import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/lib/git-providers.js';
import { createOrFindExistingPr } from '../src/lib/pull-requests.js';

// Locking tests for the "open PR → on already-exists status, look up the
// existing one" recovery flow that was copy-pasted across the github,
// gitlab, and gitverse openPullRequest implementations.

const alreadyExists = new ProviderError('conflict', 409);
const serverError = new ProviderError('boom', 500);

describe('createOrFindExistingPr', () => {
  it('returns the created PR url without calling the lookup', async () => {
    const result = await createOrFindExistingPr({
      create: async () => 'https://pr/1',
      alreadyExistsStatuses: [409],
      findExisting: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result).toEqual({ prUrl: 'https://pr/1' });
  });

  it('recovers the existing PR url on an already-exists status', async () => {
    const result = await createOrFindExistingPr({
      create: async () => {
        throw alreadyExists;
      },
      alreadyExistsStatuses: [409],
      findExisting: async () => 'https://pr/existing',
    });
    expect(result).toEqual({ prUrl: 'https://pr/existing' });
  });

  it('rethrows the original error when no existing PR is found', async () => {
    await expect(
      createOrFindExistingPr({
        create: async () => {
          throw alreadyExists;
        },
        alreadyExistsStatuses: [409],
        findExisting: async () => null,
      }),
    ).rejects.toBe(alreadyExists);
  });

  it('rethrows non-matching statuses without calling the lookup', async () => {
    await expect(
      createOrFindExistingPr({
        create: async () => {
          throw serverError;
        },
        alreadyExistsStatuses: [409],
        findExisting: async () => 'https://pr/existing',
      }),
    ).rejects.toBe(serverError);
  });

  it('rethrows non-ProviderError failures', async () => {
    const err = new TypeError('nope');
    await expect(
      createOrFindExistingPr({
        create: async () => {
          throw err;
        },
        alreadyExistsStatuses: [409],
        findExisting: async () => 'https://pr/existing',
      }),
    ).rejects.toBe(err);
  });
});
