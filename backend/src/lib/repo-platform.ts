// Repository platform detection from a repo-relative path list (root entry
// names from the provider listing, optionally deeper paths when the caller
// has a fuller tree). Pure and list-driven: the first matcher whose signals
// are present wins, in priority order android > ios > desktop > web.

export type RepoPlatform = 'android' | 'ios' | 'web' | 'desktop' | 'unknown';

const isRoot = (p: string): boolean => !p.includes('/');
const hasPath = (paths: string[], pattern: RegExp): boolean => paths.some((p) => pattern.test(p));
const hasRootFile = (paths: string[], pattern: RegExp): boolean =>
  paths.some((p) => isRoot(p) && pattern.test(p));

// Android: a gradle build at the repo root AND an Android signal (manifest
// anywhere shallow, or the conventional `app/` module layout).
const ROOT_GRADLE = /^(settings|build)\.gradle(\.kts)?$/;
const isAndroid = (paths: string[]): boolean =>
  hasRootFile(paths, ROOT_GRADLE) &&
  (hasPath(paths, /(^|\/)AndroidManifest\.xml$/) || hasPath(paths, /^app(\/|$)/));

// iOS/macOS: Xcode bundle anywhere, or root CocoaPods/SwiftPM/app plist files.
const isIos = (paths: string[]): boolean =>
  hasPath(paths, /(^|\/)[^/]*\.xcodeproj(\/|$)/) ||
  hasRootFile(paths, /^(Podfile|Package\.swift|Info\.plist)$/);

// Desktop: Tauri, Electron, or .NET markers.
const isDesktop = (paths: string[]): boolean =>
  hasPath(paths, /(^|\/)tauri\.conf\.json$/) ||
  hasPath(paths, /(^|\/)src-tauri(\/|$)/) ||
  hasRootFile(paths, /^electron-builder\.(yml|yaml|json)$/) ||
  hasPath(paths, /(^|\/)electron(\/|$)/) ||
  hasPath(paths, /\.(csproj|sln)$/);

// Web: root JS/HTML entry points or framework configs.
const isWeb = (paths: string[]): boolean =>
  hasRootFile(paths, /^(package\.json|index\.html|vite\.config\.\w+|next\.config\.\w+)$/);

const MATCHERS: Array<{ platform: RepoPlatform; matches: (paths: string[]) => boolean }> = [
  { platform: 'android', matches: isAndroid },
  { platform: 'ios', matches: isIos },
  { platform: 'desktop', matches: isDesktop },
  { platform: 'web', matches: isWeb },
];

/** Classify a repository from its path list; 'unknown' when nothing matches. */
export function detectRepoPlatform(paths: string[]): RepoPlatform {
  const normalized = paths.map((p) => p.replace(/^\.?\//, '').replace(/\/+$/, '')).filter(Boolean);
  return MATCHERS.find((m) => m.matches(normalized))?.platform ?? 'unknown';
}
