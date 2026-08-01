// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { providerLabel, ProviderIcon } from './providers';

// Locks the gitlem provider registration: it must resolve to a brand label
// and render its own icon (not the unknown-provider GitBranch fallback).
describe('gitlem provider registration', () => {
  it('uses the Gitlem brand label', () => {
    expect(providerLabel('gitlem')).toBe('Gitlem');
    expect(providerLabel('GITLEM')).toBe('Gitlem');
  });

  it('renders the gitlem icon without falling back to GitBranch', () => {
    const { container } = render(<ProviderIcon provider="gitlem" className="h-4 w-4" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // The GitlemIcon carries a nested <g> with the scale transform; the
    // GitBranch fallback has no <g> child, so its presence distinguishes them.
    expect(svg?.querySelector('g')).not.toBeNull();
  });
});
