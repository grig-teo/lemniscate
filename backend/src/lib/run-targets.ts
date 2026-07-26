// Run-target detection from a task's changed paths: which app platforms the
// task's branch touched, so the UI can offer "run the result on my device"
// per target. Pure and matcher-driven, in the style of repo-platform.ts.
//
// Each changed path is classified on its own (monorepo-aware: `android/`,
// `ios/`, `frontend/`… top-level segments win). Paths with no concrete
// signal (root-level files like README.md or package.json, unknown folders)
// fall back to the repository's detected platform. null changedPaths (old
// tasks, diff failure) means "no information" → the platform fallback alone.

export type RunTarget = 'android' | 'ios' | 'web' | 'desktop';

// Stable output order, highest install friction first.
const TARGET_ORDER: RunTarget[] = ['android', 'ios', 'web', 'desktop'];

const isRoot = (p: string): boolean => !p.includes('/');

// Classifies one repo-relative path; null when nothing concrete matches.
function classifyPath(p: string): RunTarget | null {
  // Android: conventional folder, a manifest anywhere, or gradle files.
  if (
    /^android(\/|$)/.test(p) ||
    /(^|\/)AndroidManifest\.xml$/.test(p) ||
    /(^|\/)(settings|build)\.gradle(\.kts)?$/.test(p)
  ) {
    return 'android';
  }
  // iOS: conventional folder, an Xcode bundle, or CocoaPods.
  if (
    /^ios(\/|$)/.test(p) ||
    /(^|\/)[^/]*\.xcodeproj(\/|$)/.test(p) ||
    /(^|\/)Podfile(\.[^/]*)?$/.test(p)
  ) {
    return 'ios';
  }
  // Desktop: Tauri or Electron markers.
  if (
    /(^|\/)src-tauri(\/|$)/.test(p) ||
    /(^|\/)tauri\.conf\.json$/.test(p) ||
    /(^|\/)electron(\/|$)/.test(p)
  ) {
    return 'desktop';
  }
  // Web: the web monorepo folders, docker-compose, or root web entry points.
  if (
    /^(frontend|backend)(\/|$)/.test(p) ||
    /(^|\/)docker-compose[^/]*\.ya?ml$/.test(p) ||
    (isRoot(p) && /^(index\.html|vite\.config\.\w+|next\.config\.\w+)$/.test(p))
  ) {
    return 'web';
  }
  return null;
}

function platformTarget(repoPlatform: string | null): RunTarget | null {
  return (TARGET_ORDER as string[]).includes(repoPlatform ?? '')
    ? (repoPlatform as RunTarget)
    : null;
}

/**
 * Maps a task's changed paths to the run targets it affected.
 * - changedPaths null (unknown) → single target from repoPlatform, else [].
 * - changedPaths [] (no changes) → [].
 * - otherwise: union of per-path classifications, plus the repoPlatform
 *   fallback when some path carried no concrete signal.
 */
export function detectRunTargets(
  changedPaths: string[] | null,
  repoPlatform: string | null,
): RunTarget[] {
  const fallback = platformTarget(repoPlatform);
  if (changedPaths === null) return fallback ? [fallback] : [];
  if (changedPaths.length === 0) return [];
  const found = new Set<RunTarget>();
  let ambiguous = false;
  for (const raw of changedPaths) {
    const p = raw.replace(/^\.?\//, '').replace(/\/+$/, '');
    if (!p) continue;
    const target = classifyPath(p);
    if (target) found.add(target);
    else ambiguous = true;
  }
  if (ambiguous && fallback) found.add(fallback);
  return TARGET_ORDER.filter((target) => found.has(target));
}
