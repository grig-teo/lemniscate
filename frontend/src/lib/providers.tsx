/**
 * Single source of truth for git-host provider presentation: which icon
 * represents a provider and how its name is cased. Used by the repo
 * sidebar, the settings connections tab, and the login page.
 */
import { GitBranch, Github, Gitlab, Globe } from 'lucide-react';

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
  if (name === 'gitee') return <Globe className={className} aria-hidden />;
  return <GitBranch className={className} aria-hidden />; // gitverse + unknown
}
