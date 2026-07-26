import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fetchProviderProfile } from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import {
  AUTH_COOKIE,
  authenticatedUserId,
  bumpSessionVersion,
  clearAuthCookie,
  verifyAuthToken,
} from '../plugins/auth.js';
import { finishOAuthLogin, resolveOAuthIdentity } from './auth-identity.js';
import {
  assertGrantedScopes,
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  githubAppClientIdError,
  isOAuthConfigured,
  PKCE_COOKIE,
  setOAuthCookie,
  signState,
  STATE_COOKIE,
  supportsPkce,
  verifyState,
  type OAuthProviderConfig,
  type OAuthProviderName,
} from './auth-oauth.js';

// Auth route handlers: session info, logout, and the per-provider OAuth
// login redirect + callback.

export async function meHandler(request: FastifyRequest) {
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
}

// Logout revokes the session server-side (sv bump kills every token
// issued so far) before clearing the cookie.
export async function logoutHandler(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[AUTH_COOKIE];
  const payload = token ? verifyAuthToken(token) : null;
  if (payload) {
    await bumpSessionVersion(payload.userId).catch(() => undefined);
  }
  clearAuthCookie(reply);
  return reply.code(204).send();
}

// GET /auth/:provider — redirects to the provider's authorize URL with the
// signed state nonce (and PKCE challenge where supported) in cookies.
export function oauthLoginHandler(provider: OAuthProviderName, providerConfig: OAuthProviderConfig) {
  return async (_request: FastifyRequest, reply: FastifyReply) => {
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
  };
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

// GET /auth/:provider/callback — validates code+state, exchanges the code,
// resolves the identity, and finishes the login.
export function oauthCallbackHandler(
  provider: OAuthProviderName,
  providerConfig: OAuthProviderConfig,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
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
  };
}
