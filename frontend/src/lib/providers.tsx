/**
 * Single source of truth for git-host provider presentation: which icon
 * represents a provider and how its name is cased. Used by the repo
 * sidebar, the settings connections tab, and the login page.
 */
import { GitBranch, Github, Gitlab } from 'lucide-react';

// Official Gitee glyph (lucide has no Gitee icon); currentColor so it
// inherits the surrounding text color like the lucide icons.
function GiteeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" role="img" aria-hidden className={className}>
      <path d="M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.016 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.592.592 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296z" />
    </svg>
  );
}

const PROVIDER_BRAND_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitverse: 'GitVerse',
  gitee: 'Gitee',
};

export type ProviderLabelCasing = 'brand' | 'capitalized';

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Display name for a provider. `brand` keeps the official casing
 * (GitHub/GitLab/GitVerse); `capitalized` just upper-cases the first letter.
 */
export function providerLabel(provider: string, casing: ProviderLabelCasing = 'brand'): string {
  const name = provider.toLowerCase();
  if (casing === 'capitalized') return capitalize(name);
  return PROVIDER_BRAND_LABELS[name] ?? capitalize(name);
}

/** Icon for a provider; unknown providers fall back to the GitVerse glyph. */
export function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  const name = provider.toLowerCase();
  if (name === 'github') return <Github className={className} aria-hidden />;
  if (name === 'gitlab') return <Gitlab className={className} aria-hidden />;
  if (name === 'gitee') return <GiteeIcon className={className} />;
  return <GitBranch className={className} aria-hidden />; // gitverse + unknown
}
