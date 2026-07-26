import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { hasAnyScope, ProviderError, type ProviderName } from '../lib/git-providers.js';
import { tokenExpiryFromNow } from '../lib/token-refresh.js';

// OAuth provider configuration and flow primitives for GitHub, GitLab, and
// Gitee. GitVerse has no public OAuth, so it connects via PAT through the
// connections route instead.
//
// The OAuth `state` nonce is stored in a short-lived cookie, signed with an
// HMAC derived from JWT_SECRET (@fastify/cookie is registered without a
// signing secret, so we sign the value ourselves). GitHub and GitLab flows
// additionally use PKCE (S256): the verifier lives in a second short-lived
// cookie and is sent on the token exchange.

export const STATE_COOKIE = 'lemniscate_oauth_state';
export const PKCE_COOKIE = 'lemniscate_oauth_pkce';
const STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export type OAuthProviderName = Extract<ProviderName, 'github' | 'gitlab' | 'gitee'>;

export interface OAuthProviderConfig {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

export function oauthProviders(): Record<OAuthProviderName, OAuthProviderConfig> {
  return {
    github: {
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      // read:org is required to see private organization repositories;
      // workflow is required to push branches that touch .github/workflows/*.
      scope: 'repo read:user read:org workflow',
    },
    gitlab: {
      clientId: config.GITLAB_CLIENT_ID,
      clientSecret: config.GITLAB_CLIENT_SECRET,
      authorizeUrl: 'https://gitlab.com/oauth/authorize',
      tokenUrl: 'https://gitlab.com/oauth/token',
      scope: 'api read_user',
    },
    gitee: {
      clientId: config.GITEE_CLIENT_ID,
      clientSecret: config.GITEE_CLIENT_SECRET,
      authorizeUrl: 'https://gitee.com/oauth/authorize',
      tokenUrl: 'https://gitee.com/oauth/token',
      // projects = repo read/write, user_info = profile lookup.
      scope: 'projects user_info',
    },
  };
}

function callbackUrl(provider: OAuthProviderName): string {
  return `${config.OAUTH_CALLBACK_URL.replace(/\/+$/, '')}/${provider}/callback`;
}

export function signState(nonce: string): string {
  const signature = createHmac('sha256', config.JWT_SECRET).update(nonce).digest('base64url');
  return `${nonce}.${signature}`;
}

export function verifyState(value: string): boolean {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;
  const nonce = value.slice(0, dot);
  return timingSafeEqual(signState(nonce), value);
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}

export function isOAuthConfigured(providerConfig: OAuthProviderConfig): boolean {
  return Boolean(providerConfig.clientId && providerConfig.clientSecret);
}

// GitHub App client IDs start with 'Iv'. A GitHub App mints scope-less user
// tokens (ghu_…) — no OAuth scopes means pushes 403 and org repos never
// sync, so reject the misconfiguration at login time with the fix spelled
// out. Classic OAuth App IDs are 20 hex chars or start with 'Ov'.
export function githubAppClientIdError(clientId: string | undefined): string | null {
  if (!clientId?.startsWith('Iv')) return null;
  return (
    `GITHUB_CLIENT_ID (${clientId.slice(0, 4)}…) belongs to a GitHub App, but login requires ` +
    `a classic OAuth App — create one at https://github.com/settings/developers → ` +
    `"New OAuth App" (see README "OAuth app setup")`
  );
}

// GitHub and GitLab support PKCE; Gitee's OAuth does not document it.
export function supportsPkce(provider: OAuthProviderName): boolean {
  return provider === 'github' || provider === 'gitlab';
}

// PKCE pair for the S256 flow: the verifier is stored in a cookie and sent
// on the token exchange; only its SHA-256 challenge leaves the backend.
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  provider: OAuthProviderName,
  providerConfig: OAuthProviderConfig,
  state: string,
  codeChallenge?: string,
): string {
  const url = new URL(providerConfig.authorizeUrl);
  url.searchParams.set('client_id', providerConfig.clientId as string);
  url.searchParams.set('redirect_uri', callbackUrl(provider));
  url.searchParams.set('scope', providerConfig.scope);
  url.searchParams.set('state', state);
  if (provider !== 'github') {
    url.searchParams.set('response_type', 'code');
  }
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

// Short-lived httpOnly cookie shared by the OAuth state nonce and the PKCE
// verifier.
export function setOAuthCookie(reply: FastifyReply, name: string, value: string): void {
  reply.setCookie(name, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
}

export function tokenRequestBody(
  provider: OAuthProviderName,
  providerConfig: OAuthProviderConfig,
  code: string,
  codeVerifier?: string,
): Record<string, string> {
  return {
    client_id: providerConfig.clientId as string,
    client_secret: providerConfig.clientSecret as string,
    code,
    redirect_uri: callbackUrl(provider),
    // GitLab and Gitee require the authorization_code grant type; GitHub
    // rejects unknown parameters on the token endpoint.
    ...(provider !== 'github' ? { grant_type: 'authorization_code' } : {}),
    // PKCE verifier (GitHub/GitLab authorize URLs carried the challenge).
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  };
}

// What the provider's token endpoint hands back. GitLab also returns a
// refresh_token + expires_in (access tokens live ~2h); GitHub returns
// neither, so those stay undefined and the stored fields remain null.
export interface OAuthTokens {
  accessToken: string;
  scope?: string;
  refreshToken?: string;
  expiresIn?: number;
}

export async function exchangeCode(
  provider: OAuthProviderName,
  providerConfig: OAuthProviderConfig,
  code: string,
  codeVerifier?: string,
): Promise<OAuthTokens> {
  const response = await fetch(providerConfig.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenRequestBody(provider, providerConfig, code, codeVerifier)),
  });
  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;
  if (!response.ok || !data?.access_token) {
    throw new ProviderError(
      `${provider}: token exchange failed: ${data?.error_description ?? data?.error ?? response.statusText}`,
      response.status,
    );
  }
  return {
    accessToken: data.access_token,
    scope: data.scope,
    refreshToken: data.refresh_token,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
  };
}

// Encrypts the exchanged tokens for storage on the connection. The refresh
// fields stay null for GitHub (no refresh_token) and drive the refresh flow
// in lib/token-refresh.ts for GitLab.
function oauthTokenFields(tokens: OAuthTokens): {
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
} {
  return {
    accessTokenEnc: encrypt(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
    tokenExpiresAt: tokens.expiresIn ? tokenExpiryFromNow(tokens.expiresIn) : null,
  };
}

// The token response echoes the granted scopes. Refuse to store a GitHub
// token that cannot push (missing `repo` — the classic silent-403 cause),
// and warn when org repositories will not sync (missing `read:org`).
export function assertGrantedScopes(
  provider: OAuthProviderName,
  scope: string | undefined,
  log: FastifyRequest['log'],
): void {
  if (provider !== 'github') return;
  if (!hasAnyScope(scope, ['repo'])) {
    throw new ProviderError(
      `github: OAuth granted scopes (${scope ?? 'none'}) do not include 'repo', so pushes would fail with a 403. ` +
        `Re-authorize and make sure the OAuth app requests the 'repo' scope.`,
    );
  }
  if (!hasAnyScope(scope, ['read:org'])) {
    log.warn('github OAuth token has no read:org scope; organization repositories will not sync');
  }
  if (!hasAnyScope(scope, ['workflow'])) {
    log.warn(
      'github OAuth token has no workflow scope; pushes touching .github/workflows will be rejected',
    );
  }
}

// The stored-token column set for an OAuth (re)connect: fresh encrypted
// tokens, tokenType 'oauth', and a reactivated row.
export function oauthConnectionFields(tokens: OAuthTokens) {
  return { ...oauthTokenFields(tokens), tokenType: 'oauth', disconnectedAt: null } as const;
}
