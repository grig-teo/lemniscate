import { describe, expect, it } from 'vitest';
import { createRepoBodySchema } from '../src/routes/connections.js';

// Locking tests for POST /connections/:id/repositories: the body schema the
// route validates before delegating to the provider create-repo registry.

describe('createRepoBodySchema', () => {
  it('accepts a name with an optional private flag', () => {
    expect(createRepoBodySchema.safeParse({ name: 'new-repo' }).success).toBe(true);
    expect(createRepoBodySchema.safeParse({ name: 'new-repo', private: true }).success).toBe(
      true,
    );
  });

  it('rejects an empty or over-long name', () => {
    expect(createRepoBodySchema.safeParse({ name: '' }).success).toBe(false);
    expect(createRepoBodySchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(createRepoBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-boolean private flag', () => {
    expect(createRepoBodySchema.safeParse({ name: 'r', private: 'yes' }).success).toBe(false);
  });
});
