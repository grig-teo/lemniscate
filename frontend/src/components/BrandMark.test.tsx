import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('renders the wordmark in lowercase', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('>lemniscate<');
    expect(html).not.toContain('>Lemniscate<');
  });

  it('renders hello near the logo', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('>hello<');
  });

  it('sizes the animated logo to twice the label font size (2em box)', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('h-[2em]');
    expect(html).toContain('w-[2em]');
  });

  it('sets the label font size on the lockup so the 2em mark scales with it', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('text-lg');
  });

  it('animates the swarm by default', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('animateMotion');
  });

  it('shows only the static mark (no swarm) when animate is false', () => {
    const html = renderToStaticMarkup(<BrandMark animate={false} />);
    expect(html).not.toContain('animateMotion');
    expect(html).toContain('h-[2em]');
  });
});
