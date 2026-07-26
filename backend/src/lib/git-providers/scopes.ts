import { ProviderError, type ProviderName } from './types.js';

// OAuth scope parsing and the shared "no push access" failure used by every
// provider's push pre-flight.

// Parses an OAuth scope list ("repo, read:user" or "repo read:user") and
// reports whether any of the wanted scopes is granted. Single home for scope
// parsing — used by the push pre-flight and the OAuth exchange validation.
export function hasAnyScope(
  granted: string | null | undefined,
  wanted: string[],
): boolean {
  if (!granted) return false;
  const scopes = granted.split(/[\s,]+/).filter(Boolean);
  return wanted.some((scope) => scopes.includes(scope));
}

// Shared failure for the push pre-flight: one message shape for every
// provider so the task error always tells the user how to fix it, with a
// provider-specific hint (a GitHub hint in a GitLab error misleads).
const PUSH_ACCESS_HINTS: Record<ProviderName, string> = {
  github: `'repo' scope or a fine-grained PAT with Contents: write`,
  gitlab: `the 'api' scope and a Developer (or higher) role on the project or its group`,
  gitverse: `a token with write permission on the repository`,
  gitee: `a token with the 'projects' scope and write access to the repository`,
};

export function noPushAccessError(
  provider: ProviderName,
  repoFullName: string,
  detail?: string,
): ProviderError {
  return new ProviderError(
    `${provider}: the stored token has no write (push) access to ${repoFullName}. ` +
      (detail ? `${detail} ` : '') +
      `Reconnect the ${provider} connection with a token that can write to this repository ` +
      `(${PUSH_ACCESS_HINTS[provider]}).`,
  );
}
