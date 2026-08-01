// Clone-URL hygiene shared by the repository routes and the agent
// worker. (The git HTTP auth username constant lives here too — 'oauth2'
// is the GitLab convention for PAT and OAuth; GitHub, GitVerse, and Gitee
// accept any username with a valid token password.)

export const GIT_HTTP_AUTH_USERNAME = 'oauth2';

/**
 * The username to send in the git credential helper for a provider. GitHub /
 * GitLab / GitVerse / Gitee accept any username with a valid token password
 * (convention: 'oauth2'). Gitlem's git-over-HTTP endpoint validates the login
 * against the account's email or username, so it must be the connection's
 * username — not 'oauth2' — or Basic auth is rejected.
 */
export function gitHttpAuthUsername(provider: string, connectionUsername: string): string {
  return provider.toLowerCase() === 'gitlem' ? connectionUsername : GIT_HTTP_AUTH_USERNAME;
}

// Clone URLs must never carry embedded credentials: the URL is persisted in
// the workdir's .git/config, which the YOLO agent can read. Auth instead
// travels per-invocation via a credential helper (see agent-git.ts). Any
// userinfo already present is stripped defensively.
export function tokenlessCloneUrl(cloneUrl: string): string {
  const url = new URL(cloneUrl);
  url.username = '';
  url.password = '';
  return url.toString();
}
