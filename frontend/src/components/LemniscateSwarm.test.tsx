import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LemniscateSwarm } from '@/components/LemniscateSwarm';

describe('LemniscateSwarm', () => {
  it('renders the travelling swarm by default (animate on)', () => {
    const html = renderToStaticMarkup(<LemniscateSwarm />);
    expect(html).toContain('animateMotion');
  });

  it('omits the swarm (no animateMotion) when animate is false', () => {
    const html = renderToStaticMarkup(<LemniscateSwarm animate={false} />);
    expect(html).not.toContain('animateMotion');
    // the static lemniscate stroke is still drawn
    expect(html).toContain('stroke');
  });

  it('still hides the swarm under prefers-reduced-motion when animating', () => {
    const html = renderToStaticMarkup(<LemniscateSwarm />);
    expect(html).toContain('motion-reduce:hidden');
  });
});
