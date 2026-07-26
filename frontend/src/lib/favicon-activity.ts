import { useEffect } from 'react';

/** Lucide "infinity" path — the lemniscate the favicon dot travels along. */
const LEMNISCATE_PATH =
  'M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z';

/** Mid-grey that reads on both light and dark browser chrome. */
const STROKE = '#a3a3a3';
const STROKE_WIDTH = 2.4;
const DOT_RADIUS = 2.4;

/** Default (inactive) favicon served from /public — restored when idle. */
export const INACTIVE_FAVICON_HREF = '/logo.png';
const INACTIVE_FAVICON_TYPE = 'image/png';

/** Per-frame cadence for the orbiting-dot tab icon. */
export const FAVICON_FRAME_MS = 90;

/** Number of frames in one full orbit of the lemniscate. */
const ORBIT_STEPS = 16;

/**
 * Points tracing a figure-eight (Gerono lemniscate) scaled into the 24×24
 * viewBox so the dot stays on the circular lobes of the logo path and passes
 * through the center crossing. `steps` evenly samples one full loop.
 */
export function lemniscateOrbit(steps: number): { cx: number; cy: number }[] {
  // +0.5 offset avoids sampling the center crossing exactly (a figure-eight
  // passes through it twice), which would otherwise stutter the animation.
  return Array.from({ length: steps }, (_, i) => {
    const t = ((i + 0.5) / steps) * Math.PI * 2;
    return { cx: 12 + 10 * Math.cos(t), cy: 12 + 4 * Math.sin(2 * t) };
  });
}

/** Encodes an SVG string as an `image/svg+xml` data URL. */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** One favicon frame: the faint lemniscate plus a bright dot at `point`. */
export function renderFaviconSvg(point: { cx: number; cy: number }): string {
  const dot = `cx="${point.cx.toFixed(2)}" cy="${point.cy.toFixed(2)}" r="${DOT_RADIUS}"`;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    `<path d="${LEMNISCATE_PATH}" fill="none" stroke="${STROKE}" ` +
    `stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>` +
    `<circle ${dot} fill="${STROKE}"/></svg>`
  );
}

/** Prebuilt data-URL frames for the active favicon (one orbit step each). */
export function buildActiveFaviconFrames(steps = ORBIT_STEPS): string[] {
  return lemniscateOrbit(steps).map((p) => svgToDataUrl(renderFaviconSvg(p)));
}

/** The full orbit, encoded once at module load. */
export const ACTIVE_FAVICON_FRAMES = buildActiveFaviconFrames();

/** Finds the rel="icon" link, creating one if the page has none. */
export function getFaviconLink(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const link = document.createElement('link');
  link.rel = 'icon';
  document.head.appendChild(link);
  return link;
}

/** Applies a favicon href (and optional mime type) to the icon link. */
function applyFavicon(href: string, type: string): void {
  const link = getFaviconLink();
  link.href = href;
  link.type = type;
}

/** Restore the static favicon shown when no task is running or in review. */
function restoreFavicon(): void {
  applyFavicon(INACTIVE_FAVICON_HREF, INACTIVE_FAVICON_TYPE);
}

/**
 * Animates the browser tab icon while `active` is true: a dot orbits the
 * lemniscate by cycling SVG data-URL frames on a timer (cross-browser — SMIL
 * does not animate in Chrome favicons). When inactive (or under
 * prefers-reduced-motion, to match the logo) it restores the static favicon.
 */
export function useFaviconActivity(active: boolean): void {
  useEffect(() => {
    if (!active || prefersReducedMotion()) {
      restoreFavicon();
      return;
    }
    const frames = ACTIVE_FAVICON_FRAMES;
    let index = 0;
    applyFavicon(frames[0]!, 'image/svg+xml');
    const timer = window.setInterval(() => {
      index = (index + 1) % frames.length;
      applyFavicon(frames[index]!, 'image/svg+xml');
    }, FAVICON_FRAME_MS);
    return () => {
      window.clearInterval(timer);
      restoreFavicon();
    };
  }, [active]);
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
