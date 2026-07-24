import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { fetchProviderProfile, hasAnyScope, ProviderError, type ProviderName } from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import { syncConnectionByIdBestEffort } from '../lib/repo-sync.js';
import { tokenExpiryFromNow } from '../lib/token-refresh.js';
import {
  AUTH_COOKIE,
  authenticatedUserId,
  bumpSessionVersion,
  clearAuthCookie,
  requireAuth,
  setAuthCookie,
  verifyAuthToken,
} from '../plugins/auth.js';

// OAuth login flow for GitHub, GitLab, and Gitee. GitVerse has no public
// OAuth, so it connects via PAT through the connections route instead.
//
// The OAuth `state` nonce is stored in a short-lived cookie, signed with an
// HMAC derived from JWT_SECRET (@fastify/cookie is registered without a
// signing secret, so we sign the value ourselves). GitHub and GitLab flows
// additionally use PKCE (S256): the verifier lives in a second short-lived
// cookie and is sent on the token exchange.

const STATE_COOKIE = 'lemniscate_oauth_state';
const PKCE_COOKIE = 'lemniscate_oauth_pkce';
const STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

// Login endpoints are the most attacked surface — keep the bucket tight.
const AUTH_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

type OAuthProviderName = Extract<ProviderName, 'github' | 'gitlab' | 'gitee'>;

interface OAuthProviderConfig {
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
      // read:org is required to see private organization repositories.
      scope: 'repo read:user read:org',
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

function isOAuthConfigured(providerConfig: OAuthProviderConfig): boolean {
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
function supportsPkce(provider: OAuthProviderName): boolean {
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
function setOAuthCookie(reply: FastifyReply, name: string, value: string): void {
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
interface OAuthTokens {
  accessToken: string;
  scope?: string;
  refreshToken?: string;
  expiresIn?: number;
}

async function exchangeCode(
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
function assertGrantedScopes(
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
}

// Finds the user behind an OAuth connection, or creates a new user plus
// connection. The stored tokens are always refreshed.
async function upsertOAuthConnection(
  provider: OAuthProviderName,
  username: string,
  tokens: OAuthTokens,
): Promise<{ userId: string; connectionId: string }> {
  const tokenFields = oauthTokenFields(tokens);
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { ...tokenFields, tokenType: 'oauth' },
    });
    return { userId: connection.userId, connectionId: connection.id };
  }
  const user = await prisma.user.create({
    data: {
      gitConnections: {
        create: { provider, username, ...tokenFields, tokenType: 'oauth' },
      },
    },
    include: { gitConnections: { select: { id: true } } },
  });
  return { userId: user.id, connectionId: user.gitConnections[0]?.id as string };
}

// Returns the logged-in user id from the session cookie, or null when the
// request carries no valid session (missing/invalid/expired/revoked token,
// or the user was deleted). Used to attach new OAuth connections to the
// current user instead of creating a new identity.
async function sessionUserId(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) return null;
  const payload = verifyAuthToken(token);
  if (!payload) return null;
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || user.sessionVersion !== payload.sv) return null;
  return user.id;
}

// Attaches an OAuth connection to the given (logged-in) user. Reconnecting a
// host refreshes the stored tokens and re-points the connection at this user —
// which also merges identities that were split by earlier logins.
async function attachOAuthConnection(
  userId: string,
  provider: OAuthProviderName,
  username: string,
  tokens: OAuthTokens,
): Promise<string> {
  const tokenFields = oauthTokenFields(tokens);
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { ...tokenFields, tokenType: 'oauth', userId },
    });
    return connection.id;
  }
  const connection = await prisma.gitConnection.create({
    data: { provider, username, ...tokenFields, tokenType: 'oauth', userId },
  });
  return connection.id;
}

// Decides whose identity the OAuth connection belongs to: the logged-in
// session user when there is one, otherwise the no-session upsert path.
async function resolveOAuthIdentity(
  provider: OAuthProviderName,
  username: string,
  tokens: OAuthTokens,
  request: FastifyRequest,
): Promise<{ userId: string; connectionId: string }> {
  const loggedInUserId = await sessionUserId(request);
  if (!loggedInUserId) {
    return upsertOAuthConnection(provider, username, tokens);
  }
  const connectionId = await attachOAuthConnection(loggedInUserId, provider, username, tokens);
  return { userId: loggedInUserId, connectionId };
}

// Sets the session cookie, kicks off a best-effort repo sync, and redirects
// to the dashboard after a successful OAuth round-trip.
async function finishOAuthLogin(
  userId: string,
  connectionId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  await setAuthCookie(reply, userId);
  // Pull repos right away so the landing/dashboard are populated on first
  // visit; a failed sync must not break the login.
  await syncConnectionByIdBestEffort(connectionId, request.log);
  return reply.redirect(`${config.FRONTEND_URL.replace(/\/+$/, '')}/dashboard`, 302);
}
const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

// Validates the callback query + state cookie. Sends the 400 and returns
// null on failure; returns the authorization code on success.
function validCallbackCode(request: FastifyRequest, reply: FastifyReply): string | null {
  const parsedQuery = callbackQuerySchema.safeParse(request.query);
  const storedState = request.cookies[STATE_COOKIE];
  reply.clearCookie(STATE_COOKIE, { path: '/' });
  if (!parsedQuery.success || !storedState || !verifyState(storedState)) {
    void reply.code(400).send({ error: 'Invalid OAuth callback (bad code or state)' });
    return null;
  }
  if (parsedQuery.data.state !== storedState) {
    void reply.code(400).send({ error: 'OAuth state mismatch' });
    return null;
  }
  return parsedQuery.data.code;
}

async function handleOAuthCallback(
  provider: OAuthProviderName,
  providerConfig: OAuthProviderConfig,
  code: string,
  codeVerifier: string | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  try {
    const tokens = await exchangeCode(provider, providerConfig, code, codeVerifier);
    assertGrantedScopes(provider, tokens.scope, request.log);
    // OAuth access tokens authenticate as Bearer (matters for GitLab).
    const profile = await fetchProviderProfile(provider, tokens.accessToken, null, 'oauth');
    const { userId, connectionId } = await resolveOAuthIdentity(
      provider,
      profile.username,
      tokens,
      request,
    );
    return finishOAuthLogin(userId, connectionId, request, reply);
  } catch (err) {
    // Provider error details (error_description & co.) go to the log only —
    // the client gets a generic message.
    request.log.error(err, 'oauth callback failed');
    return reply.code(502).send({ error: `OAuth login via ${provider} failed` });
  }
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/auth/me', { preHandler: requireAuth, config: { rateLimit: AUTH_RATE_LIMIT } }, async (request) => {
    const userId = authenticatedUserId(request);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        gitConnections: {
          select: { id: true, provider: true, baseUrl: true, username: true },
        },
      },
    });
    return { user };
  });

  // Logout revokes the session server-side (sv bump kills every token
  // issued so far) before clearing the cookie.
  app.post('/auth/logout', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const token = request.cookies[AUTH_COOKIE];
    const payload = token ? verifyAuthToken(token) : null;
    if (payload) {
      await bumpSessionVersion(payload.userId).catch(() => undefined);
    }
    clearAuthCookie(reply);
    return reply.code(204).send();
  });

  for (const provider of ['github', 'gitlab', 'gitee'] as const) {
    app.get(`/auth/${provider}`, { config: { rateLimit: AUTH_RATE_LIMIT } }, async (_request, reply) => {
      const providerConfig = oauthProviders()[provider];
      if (!isOAuthConfigured(providerConfig)) {
        return reply.code(501).send({
          error: `OAuth login via ${provider} is not configured: set ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET`,
        });
      }
      const appKindError =
        provider === 'github' ? githubAppClientIdError(providerConfig.clientId) : null;
      if (appKindError) {
        return reply.code(400).send({ error: appKindError });
      }
      const state = signState(randomBytes(16).toString('base64url'));
      setOAuthCookie(reply, STATE_COOKIE, state);
      const pkce = supportsPkce(provider) ? generatePkce() : null;
      if (pkce) {
        setOAuthCookie(reply, PKCE_COOKIE, pkce.verifier);
      }
      return reply.redirect(
        buildAuthorizeUrl(provider, providerConfig, state, pkce?.challenge),
        302,
      );
    });

    app.get(`/auth/${provider}/callback`, { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
      const providerConfig = oauthProviders()[provider];
      if (!isOAuthConfigured(providerConfig)) {
        return reply.code(501).send({
          error: `OAuth login via ${provider} is not configured`,
        });
      }
      const code = validCallbackCode(request, reply);
      if (code === null) return;
      const codeVerifier = request.cookies[PKCE_COOKIE];
      reply.clearCookie(PKCE_COOKIE, { path: '/' });
      return handleOAuthCallback(provider, providerConfig, code, codeVerifier, request, reply);
    });
  }
};

export default authRoutes;
