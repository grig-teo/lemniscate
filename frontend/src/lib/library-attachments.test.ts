import { describe, expect, it } from 'vitest';

import { mergeFolders } from './library-attachments';

describe('mergeFolders', () => {
  it('always contains root first', () => {
    expect(mergeFolders([], [])).toEqual(['/']);
  });

  it('unions folders and assignment folders without duplicates', () => {
    expect(mergeFolders(['/src', '/docs'], ['/src', '/api'])).toEqual(['/', '/src', '/docs', '/api']);
  });
});
