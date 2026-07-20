import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { fetchProviderProfile, ProviderError, type ProviderName } from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import { errorMessage } from '../lib/utils.js';
import {
  authenticatedUserId,
  clearAuthCookie,
  requireAuth,
  setAuthCookie,
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
      scope: 'repo read:user',
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
): Promise<string> {
  const response = await fetch(providerConfig.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenRequestBody(provider, providerConfig, code)),
  });
  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!response.ok || !data?.access_token) {
    throw new ProviderError(
      `${provider}: token exchange failed: ${data?.error_description ?? data?.error ?? response.statusText}`,
      response.status,
    );
  }
  return data.access_token;
}

// Finds the user behind an OAuth connection, or creates a new user plus
// connection. The stored token is always refreshed.
async function upsertOAuthConnection(
  provider: OAuthProviderName,
  username: string,
  accessToken: string,
): Promise<string> {
  const accessTokenEnc = encrypt(accessToken);
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username },
  });
  if (existing) {
    await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { accessTokenEnc, tokenType: 'oauth' },
    });
    return existing.userId;
  }
  const user = await prisma.user.create({
    data: {
      gitConnections: {
        create: { provider, username, accessTokenEnc, tokenType: 'oauth' },
      },
    },
  });
  return user.id;
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
    const accessToken = await exchangeCode(provider, providerConfig, code);
    // OAuth access tokens authenticate as Bearer (matters for GitLab).
    const profile = await fetchProviderProfile(provider, accessToken, null, 'oauth');
    const userId = await upsertOAuthConnection(provider, profile.username, accessToken);
    setAuthCookie(reply, userId);
    // Land on the dashboard after a successful OAuth round-trip.
    return reply.redirect(`${config.FRONTEND_URL.replace(/\/+$/, '')}/dashboard`, 302);
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
