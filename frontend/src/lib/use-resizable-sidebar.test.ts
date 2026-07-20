import { describe, expect, it } from 'vitest';

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  readStoredSidebarWidth,
} from '@/lib/use-resizable-sidebar';

function fakeStorage(value: string | null) {
  return { getItem: (key: string) => (key === SIDEBAR_WIDTH_STORAGE_KEY ? value : null) };
}

describe('clampSidebarWidth', () => {
  it('keeps an in-range width', () => {
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it('clamps below the minimum', () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('clamps above the maximum', () => {
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('rounds fractional widths', () => {
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('readStoredSidebarWidth', () => {
  it('returns the default when storage is unavailable', () => {
    expect(readStoredSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('returns the default when nothing is stored', () => {
    expect(readStoredSidebarWidth(fakeStorage(null))).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('restores a stored width', () => {
    expect(readStoredSidebarWidth(fakeStorage('320'))).toBe(320);
  });

  it('clamps a stored out-of-range width', () => {
    expect(readStoredSidebarWidth(fakeStorage('10'))).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('falls back to the default for a non-numeric value', () => {
    expect(readStoredSidebarWidth(fakeStorage('wide'))).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
