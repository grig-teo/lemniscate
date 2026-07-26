// Barrel module — drop-in replacement for the original 896-line
// git-providers.ts, which was split into focused per-provider modules
// under ./git-providers/ per AGENTS.md section 2 (300-line module limit)
// and section 6 (extract-and-delete: no logic remains in this file).
//
// Every previously public export is re-exported here from its new single
// home, so existing imports from '../lib/git-providers.js' keep working
// unchanged under tsc strict:
//
//   types.js       — GitProvider, NormalizedRepo, connection/repo shapes
//   http.js        — ProviderError and the shared HTTP helpers
//   scopes.js      — hasAnyScope and scope-checking helpers
//   clone-url.js   — tokenlessCloneUrl, GIT_HTTP_AUTH_USERNAME
//   bare.js        — isBareRootListing and bare-repo listing helpers
//   github.js      — GITHUB_API, githubHeaders, GitHub client
//   gitlab.js      — gitlabApiBase, gitlabHeaders, GitLab client
//   gitee.js       — GITEE_API, giteeHeaders, normalizeGiteeRepo, Gitee client
//   gitverse.js    — GITVERSE_API, gitverseBase, gitverseApiBase,
//                    normalizeGitverseRepo, GitVerse client
//   registry.js    — providerApis registry, fetchProviderProfile,
//                    assertRepoPushAccess, getProviderClient
//
// The provider factory (the single switch on provider type, per AGENTS.md
// section 4) lives in registry.js and is re-exported through this barrel
// like everything else.
export * from './git-providers/types.js';
export * from './git-providers/http.js';
export * from './git-providers/scopes.js';
export * from './git-providers/clone-url.js';
export * from './git-providers/bare.js';
export * from './git-providers/github.js';
export * from './git-providers/gitlab.js';
export * from './git-providers/gitee.js';
export * from './git-providers/gitverse.js';
export * from './git-providers/registry.js';
