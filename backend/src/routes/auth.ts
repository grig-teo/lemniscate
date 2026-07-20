import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { fetchProviderProfile, hasAnyScope, ProviderError, type ProviderName } from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import { syncConnectionByIdBestEffort } from '../lib/repo-sync.js';
import { errorMessage } from '../lib/utils.js';
import {
  AUTH_COOKIE,
  authenticatedUserId,
  clearAuthCookie,
  requireAuth,
  setAuthCookie,
  verifyAuthToken,
} from '../plugins/auth.js';

// OAuth login flow for GitHub and GitLab. GitVerse has no public OAuth, so
// it connects via PAT through the connections route instead.
//
// The OAuth `state` nonce is stored in a short-lived cookie, signed with an
// HMAC derived from JWT_SECRET (@fastify/cookie is registered without a
// signing secret, so we sign the value ourselves).

const STATE_COOKIE = 'lemniscate_oauth_state';
const STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

type OAuthProviderName = Extract<ProviderName, 'github' | 'gitlab'>;

interface OAuthProviderConfig {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

function oauthProviders(): Record<OAuthProviderName, OAuthProviderConfig> {
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
  };
}

function callbackUrl(provider: OAuthProviderName): string {
  return `${config.OAUTH_CALLBACK_URL.replace(/\/+$/, '')}/${provider}/callback`;
}

function signState(nonce: string): string {
  const signature = createHmac('sha256', config.JWT_SECRET).update(nonce).digest('base64url');
  return `${nonce}.${signature}`;
}

function verifyState(value: string): boolean {
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

function buildAuthorizeUrl(
  provider: OAuthProviderName,
  providerConfig: OAuthProviderConfig,
  state: string,
): string {
  const url = new URL(providerConfig.authorizeUrl);
  url.searchParams.set('client_id', providerConfig.clientId as string);
  url.searchParams.set('redirect_uri', callbackUrl(provider));
  url.searchParams.set('scope', providerConfig.scope);
  url.searchParams.set('state', state);
  if (provider === 'gitlab') {
    url.searchParams.set('response_type', 'code');
  }
  return url.toString();
}

function setStateCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(STATE_COOKIE, state, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
}

function tokenRequestBody(
  provider: OAuthProviderName,
  providerConfig: OAuthProviderConfig,
  code: string,
): Record<string, string> {
  return {
    client_id: providerConfig.clientId as string,
    client_secret: providerConfig.clientSecret as string,
    code,
    redirect_uri: callbackUrl(provider),
    ...(provider === 'gitlab' ? { grant_type: 'authorization_code' } : {}),
  };
}

async function exchangeCode(
  provider: OAuthProviderName,
  providerConfig: OAuthProviderConfig,
  code: string,
): Promise<{ accessToken: string; scope?: string }> {
  const response = await fetch(providerConfig.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenRequestBody(provider, providerConfig, code)),
  });
  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!response.ok || !data?.access_token) {
    throw new ProviderError(
      `${provider}: token exchange failed: ${data?.error_description ?? data?.error ?? response.statusText}`,
      response.status,
    );
  }
  return { accessToken: data.access_token, scope: data.scope };
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
// connection. The stored token is always refreshed.
async function upsertOAuthConnection(
  provider: OAuthProviderName,
  username: string,
  accessToken: string,
): Promise<{ userId: string; connectionId: string }> {
  const accessTokenEnc = encrypt(accessToken);
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { accessTokenEnc, tokenType: 'oauth' },
    });
    return { userId: connection.userId, connectionId: connection.id };
  }
  const user = await prisma.user.create({
    data: {
      gitConnections: {
        create: { provider, username, accessTokenEnc, tokenType: 'oauth' },
      },
    },
    include: { gitConnections: { select: { id: true } } },
  });
  return { userId: user.id, connectionId: user.gitConnections[0]?.id as string };
}

// Returns the logged-in user id from the session cookie, or null when the
// request carries no valid session (missing/invalid/expired token, or the
// user was deleted). Used to attach new OAuth connections to the current
// user instead of creating a new identity.
async function sessionUserId(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) return null;
  const userId = verifyAuthToken(token);
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.id ?? null;
}

// Attaches an OAuth connection to the given (logged-in) user. Reconnecting a
// host refreshes the stored token and re-points the connection at this user —
// which also merges identities that were split by earlier logins.
async function attachOAuthConnection(
  userId: string,
  provider: OAuthProviderName,
  username: string,
  accessToken: string,
): Promise<string> {
  const accessTokenEnc = encrypt(accessToken);
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { accessTokenEnc, tokenType: 'oauth', userId },
    });
    return connection.id;
  }
  const connection = await prisma.gitConnection.create({
    data: { provider, username, accessTokenEnc, tokenType: 'oauth', userId },
  });
  return connection.id;
}

// Decides whose identity the OAuth connection belongs to: the logged-in
// session user when there is one, otherwise the no-session upsert path.
async function resolveOAuthIdentity(
  provider: OAuthProviderName,
  username: string,
  accessToken: string,
  request: FastifyRequest,
): Promise<{ userId: string; connectionId: string }> {
  const loggedInUserId = await sessionUserId(request);
  if (!loggedInUserId) {
    return upsertOAuthConnection(provider, username, accessToken);
  }
  const connectionId = await attachOAuthConnection(loggedInUserId, provider, username, accessToken);
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
  setAuthCookie(reply, userId);
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
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  try {
    const { accessToken, scope } = await exchangeCode(provider, providerConfig, code);
    assertGrantedScopes(provider, scope, request.log);
    // OAuth access tokens authenticate as Bearer (matters for GitLab).
    const profile = await fetchProviderProfile(provider, accessToken, null, 'oauth');
    const { userId, connectionId } = await resolveOAuthIdentity(
      provider,
      profile.username,
      accessToken,
      request,
    );
    return finishOAuthLogin(userId, connectionId, request, reply);
  } catch (err) {
    request.log.error(err, 'oauth callback failed');
    return reply.code(502).send({
      error: `OAuth login via ${provider} failed: ${errorMessage(err)}`,
    });
  }
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/auth/me', { preHandler: requireAuth }, async (request) => {
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

  app.post('/auth/logout', async (_request, reply) => {
    clearAuthCookie(reply);
    return reply.code(204).send();
  });

  for (const provider of ['github', 'gitlab'] as const) {
    app.get(`/auth/${provider}`, async (_request, reply) => {
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
      setStateCookie(reply, state);
      return reply.redirect(buildAuthorizeUrl(provider, providerConfig, state), 302);
    });

    app.get(`/auth/${provider}/callback`, async (request, reply) => {
      const providerConfig = oauthProviders()[provider];
      if (!isOAuthConfigured(providerConfig)) {
        return reply.code(501).send({
          error: `OAuth login via ${provider} is not configured`,
        });
      }
      const code = validCallbackCode(request, reply);
      if (code === null) return;
      return handleOAuthCallback(provider, providerConfig, code, request, reply);
    });
  }
};

export default authRoutes;
