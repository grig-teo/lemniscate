import { describe, expect, it } from 'vitest';

import { canNextPage, canPrevPage, clampPage, pageCount } from './library';

describe('pageCount', () => {
  it('is at least 1', () => {
    expect(pageCount(0, 5)).toBe(1);
  });

  it('rounds up', () => {
    expect(pageCount(6, 5)).toBe(2);
    expect(pageCount(10, 5)).toBe(2);
    expect(pageCount(11, 5)).toBe(3);
  });
});

describe('canPrevPage / canNextPage', () => {
  it('prev only after the first page', () => {
    expect(canPrevPage(1)).toBe(false);
    expect(canPrevPage(2)).toBe(true);
  });

  it('next only before the last page', () => {
    expect(canNextPage(1, 12, 5)).toBe(true);
    expect(canNextPage(3, 12, 5)).toBe(false);
  });
});

describe('clampPage', () => {
  it('keeps pages inside [1, pageCount]', () => {
    expect(clampPage(0, 12, 5)).toBe(1);
    expect(clampPage(99, 12, 5)).toBe(3);
    expect(clampPage(2, 12, 5)).toBe(2);
  });
});
