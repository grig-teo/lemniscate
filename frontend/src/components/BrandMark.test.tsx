import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('renders the wordmark in lowercase', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('>lemniscate<');
    expect(html).not.toContain('>Lemniscate<');
  });

  it('sizes the animated logo to the label font size (1em box)', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('h-[1em]');
    expect(html).toContain('w-[1em]');
  });

  it('sets the label font size on the lockup so the 1em mark matches it', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('text-lg');
  });
});
