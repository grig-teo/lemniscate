import { describe, expect, it } from 'vitest';

import { providerLabel } from '@/lib/providers';

describe('providerLabel', () => {
  it('uses brand casing by default', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('gitlab')).toBe('GitLab');
    expect(providerLabel('gitverse')).toBe('GitVerse');
  });

  it('supports plain capitalized casing', () => {
    expect(providerLabel('github', 'capitalized')).toBe('Github');
    expect(providerLabel('gitverse', 'capitalized')).toBe('Gitverse');
  });

  it('capitalizes unknown providers in both casings', () => {
    expect(providerLabel('bitbucket')).toBe('Bitbucket');
    expect(providerLabel('bitbucket', 'capitalized')).toBe('Bitbucket');
    expect(providerLabel('GITHUB', 'capitalized')).toBe('Github');
  });
});
