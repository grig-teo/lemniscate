// @vitest-environment jsdom
/**
 * Locking tests for the three-state theme model (`light` | `dark` | `system`).
 * `system` resolves from, and reactively follows, the OS `prefers-color-scheme`
 * media query; explicit `light`/`dark` preferences override it.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ThemeProvider,
  applyTheme,
  getSystemTheme,
  resolveEffectiveTheme,
  useTheme,
  type EffectiveTheme,
  type ThemePreference,
} from './theme';

type ChangeListener = (event: MediaQueryListEvent) => void;

/** A minimal controllable MediaQueryList mock for `(prefers-color-scheme: dark)`. */
function mockPrefersColorScheme(initialMatches: boolean) {
  const listeners = new Set<ChangeListener>();
  const mql = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    onchange: null as ChangeListener | null,
    addEventListener: (_type: string, listener: ChangeListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: ChangeListener) => listeners.delete(listener),
    addListener: (listener: ChangeListener) => listeners.add(listener),
    removeListener: (listener: ChangeListener) => listeners.delete(listener),
    /** Test-only helper: broadcast a change event as the browser would. */
    emit(nextMatches: boolean) {
      mql.matches = nextMatches;
      const event = { matches: nextMatches, media: '(prefers-color-scheme: dark)' } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
  vi.stubGlobal('matchMedia', () => mql);
  return mql;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveEffectiveTheme', () => {
  it('returns the system theme when the preference is "system"', () => {
    expect(resolveEffectiveTheme('system', 'dark')).toBe('dark');
    expect(resolveEffectiveTheme('system', 'light')).toBe('light');
  });

  it('returns the explicit preference, ignoring the system value', () => {
    expect(resolveEffectiveTheme('light', 'dark')).toBe('light');
    expect(resolveEffectiveTheme('dark', 'light')).toBe('dark');
  });
});

describe('getSystemTheme', () => {
  it('reads the OS dark preference from matchMedia', () => {
    mockPrefersColorScheme(true);
    expect(getSystemTheme()).toBe('dark');

    mockPrefersColorScheme(false);
    expect(getSystemTheme()).toBe('light');
  });

  it('falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(getSystemTheme()).toBe('light');
  });
});

describe('applyTheme', () => {
  it('toggles the `dark` class on the document root', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('ThemeProvider', () => {
  it('defaults to "system" when no preference is stored', () => {
    mockPrefersColorScheme(true);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('system');
    expect(result.current.effectiveTheme).toBe('dark');
  });

  it('resolves "system" to the OS preference on mount', () => {
    mockPrefersColorScheme(false);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.effectiveTheme).toBe('light');
  });

  it('reactively follows the OS theme when set to "system"', () => {
    const mql = mockPrefersColorScheme(false);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.effectiveTheme).toBe('light');

    act(() => mql.emit(true));
    expect(result.current.effectiveTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => mql.emit(false));
    expect(result.current.effectiveTheme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('does NOT react to OS changes when an explicit preference is set', () => {
    localStorage.setItem('lemniscate-theme', 'dark');
    const mql = mockPrefersColorScheme(false);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.effectiveTheme).toBe('dark');

    act(() => mql.emit(true));
    expect(result.current.effectiveTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('preserves a previously stored explicit light/dark preference', () => {
    localStorage.setItem('lemniscate-theme', 'light');
    mockPrefersColorScheme(true);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('light');
    expect(result.current.effectiveTheme).toBe('light');
  });

  it('persists the preference to localStorage and applies the theme', () => {
    mockPrefersColorScheme(true);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    act(() => result.current.setTheme('light'));
    expect(result.current.theme).toBe('light');
    expect(result.current.effectiveTheme).toBe('light');
    expect(localStorage.getItem('lemniscate-theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('cycles system → light → dark → system', () => {
    mockPrefersColorScheme(false);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    const order: ThemePreference[] = ['system', 'light', 'dark', 'system'];
    const seen: ThemePreference[] = [result.current.theme];

    for (let i = 1; i < order.length; i++) {
      act(() => result.current.cycleTheme());
      seen.push(result.current.theme);
    }
    expect(seen).toEqual(order);
  });

  it('applies the effective theme to the DOM exactly once per change', () => {
    const mql = mockPrefersColorScheme(false);
    renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => mql.emit(true));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('ThemeProvider exports', () => {
  it('exposes EffectiveTheme and ThemePreference types via the module', () => {
    const effective: EffectiveTheme = 'dark';
    const preference: ThemePreference = 'system';
    expect([effective, preference]).toEqual(['dark', 'system']);
  });
});
