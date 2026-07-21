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

  it('defaults readme to true', () => {
    const parsed = createRepoBodySchema.parse({ name: 'r' });
    expect(parsed.readme).toBe(true);
    expect(createRepoBodySchema.parse({ name: 'r', readme: false }).readme).toBe(false);
  });

  it('accepts skill slugs, an AGENTS.md skill id, and uploaded content', () => {
    const parsed = createRepoBodySchema.safeParse({
      name: 'r',
      skillSlugs: ['code-style', 'testing'],
      agentsMdSkillId: 'skill_123',
      agentsMdContent: '# Custom rules\n',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an explicit null agentsMdSkillId', () => {
    expect(
      createRepoBodySchema.safeParse({ name: 'r', agentsMdSkillId: null }).success,
    ).toBe(true);
  });

  it('rejects empty slugs, more than 20 slugs, and non-string slugs', () => {
    expect(createRepoBodySchema.safeParse({ name: 'r', skillSlugs: [''] }).success).toBe(false);
    expect(
      createRepoBodySchema.safeParse({
        name: 'r',
        skillSlugs: Array.from({ length: 21 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(false);
    expect(createRepoBodySchema.safeParse({ name: 'r', skillSlugs: [1] }).success).toBe(false);
  });

  it('rejects an empty agentsMdSkillId and over-long uploaded content', () => {
    expect(createRepoBodySchema.safeParse({ name: 'r', agentsMdSkillId: '' }).success).toBe(false);
    expect(
      createRepoBodySchema.safeParse({ name: 'r', agentsMdContent: 'x'.repeat(100_001) }).success,
    ).toBe(false);
    expect(
      createRepoBodySchema.safeParse({ name: 'r', agentsMdContent: 'x'.repeat(100_000) }).success,
    ).toBe(true);
  });
});
