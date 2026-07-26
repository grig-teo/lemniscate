import { describe, expect, it } from 'vitest';

import {
  isSectionCollapsed,
  toggleSection,
  SECTION_IDS,
  SECTIONS_STORAGE_KEY,
} from '@/lib/sidebar-sections';

describe('SECTION_IDS', () => {
  it('covers the three left-pane sections', () => {
    expect(SECTION_IDS).toEqual(['repositories', 'services', 'devices']);
  });

  it('has a stable storage key', () => {
    expect(SECTIONS_STORAGE_KEY).toBe('lemniscate.collapsed-sidebar-sections');
  });
});

describe('isSectionCollapsed', () => {
  it('defaults to visible when nothing is stored', () => {
    expect(isSectionCollapsed({}, 'services')).toBe(false);
  });

  it('reads a stored collapsed flag', () => {
    expect(isSectionCollapsed({ devices: true }, 'devices')).toBe(true);
    expect(isSectionCollapsed({ devices: false }, 'devices')).toBe(false);
  });
});

describe('toggleSection', () => {
  it('collapses a visible section', () => {
    expect(toggleSection({}, 'repositories')).toEqual({ repositories: true });
  });

  it('expands a collapsed section', () => {
    expect(toggleSection({ services: true }, 'services')).toEqual({ services: false });
  });

  it('leaves other sections untouched', () => {
    const prev = { repositories: true, services: false };
    expect(toggleSection(prev, 'devices')).toEqual({
      repositories: true,
      services: false,
      devices: true,
    });
  });

  it('does not mutate the input map', () => {
    const prev = { devices: true };
    toggleSection(prev, 'devices');
    expect(prev).toEqual({ devices: true });
  });
});
