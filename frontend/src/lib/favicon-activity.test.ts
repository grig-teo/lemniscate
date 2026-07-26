// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import {
  ACTIVE_FAVICON_FRAMES,
  FAVICON_FRAME_MS,
  INACTIVE_FAVICON_HREF,
  buildActiveFaviconFrames,
  getFaviconLink,
  lemniscateOrbit,
  renderFaviconSvg,
  svgToDataUrl,
  useFaviconActivity,
} from '@/lib/favicon-activity';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('svgToDataUrl', () => {
  it('produces an svg+xml data URL that round-trips to the source', () => {
    const svg = '<svg><circle/></svg>';
    const url = svgToDataUrl(svg);
    expect(url.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(url.slice('data:image/svg+xml,'.length))).toBe(svg);
  });
});

describe('lemniscateOrbit', () => {
  it('returns the requested number of points within the 0–24 viewBox', () => {
    const points = lemniscateOrbit(12);
    expect(points).toHaveLength(12);
    for (const { cx, cy } of points) {
      expect(cx).toBeGreaterThanOrEqual(0);
      expect(cx).toBeLessThanOrEqual(24);
      expect(cy).toBeGreaterThanOrEqual(0);
      expect(cy).toBeLessThanOrEqual(24);
    }
  });

  it('traces the figure-eight extremes (reaches both lobes)', () => {
    const points = lemniscateOrbit(64);
    const xs = points.map((p) => p.cx);
    // right lobe reaches near x≈22, left lobe near x≈2
    expect(Math.max(...xs)).toBeGreaterThan(20);
    expect(Math.min(...xs)).toBeLessThan(4);
  });
});

describe('renderFaviconSvg', () => {
  it('draws the lemniscate stroke and a dot at the given point', () => {
    const svg = renderFaviconSvg({ cx: 12, cy: 12 });
    expect(svg).toContain('M12 12'); // the infinity path
    expect(svg).toContain('<circle'); // the orbiting dot
    expect(svg).toContain('cx="12'); // matches "12" and "12.00"
    expect(svg).toContain('cy="12');
  });
});

describe('buildActiveFaviconFrames', () => {
  it('returns one data URL per orbit step, all distinct', () => {
    const frames = buildActiveFaviconFrames(8);
    expect(frames).toHaveLength(8);
    for (const f of frames) expect(f.startsWith('data:image/svg+xml,')).toBe(true);
    expect(new Set(frames).size).toBe(frames.length);
  });
});

describe('module constants', () => {
  it('exposes prebuilt frames and the inactive favicon href', () => {
    expect(ACTIVE_FAVICON_FRAMES.length).toBeGreaterThan(1);
    expect(FAVICON_FRAME_MS).toBeGreaterThan(0);
    expect(INACTIVE_FAVICON_HREF).toBe('/logo.png');
  });
});

describe('getFaviconLink', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  it('reuses the existing rel=icon link', () => {
    const existing = document.createElement('link');
    existing.rel = 'icon';
    existing.href = '/logo.png';
    document.head.appendChild(existing);
    expect(getFaviconLink()).toBe(existing);
  });

  it('creates and appends a rel=icon link when none exists', () => {
    expect(document.querySelector('link[rel="icon"]')).toBeNull();
    const link = getFaviconLink();
    expect(link.rel).toBe('icon');
    expect(document.head.contains(link)).toBe(true);
  });
});

describe('useFaviconActivity', () => {
  beforeEach(() => {
    document.head.innerHTML = '<link rel="icon" type="image/png" href="/logo.png" />';
    vi.useFakeTimers();
  });

  it('cycles favicon frames while active', () => {
    renderHook(({ active }: { active: boolean }) => useFaviconActivity(active), {
      initialProps: { active: true },
    });
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
    expect(link.href).toContain('data:image/svg+xml');

    const firstHref = link.href;
    act(() => {
      vi.advanceTimersByTime(FAVICON_FRAME_MS);
    });
    expect(link.href).not.toBe(firstHref);
    expect(link.href).toContain('data:image/svg+xml');
  });

  it('restores the inactive favicon when activity stops', () => {
    const { rerender } = renderHook(({ active }: { active: boolean }) => useFaviconActivity(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
    expect(link.getAttribute('href')).toBe(INACTIVE_FAVICON_HREF);
    expect(link.getAttribute('type')).toBe('image/png');
  });

  it('leaves the favicon untouched when never active', () => {
    renderHook(({ active }: { active: boolean }) => useFaviconActivity(active), {
      initialProps: { active: false },
    });
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
    expect(link.getAttribute('href')).toBe('/logo.png');
  });
});
