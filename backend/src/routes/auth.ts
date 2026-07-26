import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import {
  logoutHandler,
  meHandler,
  oauthCallbackHandler,
  oauthLoginHandler,
} from './auth-handlers.js';
import { oauthProviders } from './auth-oauth.js';

// OAuth login flow for GitHub, GitLab, and Gitee. GitVerse has no public
// OAuth, so it connects via PAT through the connections route instead.
//
// Thin registration layer: provider config + flow primitives live in
// auth-oauth.ts, identity resolution in auth-identity.ts, and the handlers
// in auth-handlers.ts.

// Login endpoints are the most attacked surface — keep the bucket tight.
const AUTH_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/auth/me', { preHandler: requireAuth, config: { rateLimit: AUTH_RATE_LIMIT } }, meHandler);
  app.post('/auth/logout', { config: { rateLimit: AUTH_RATE_LIMIT } }, logoutHandler);

  for (const provider of ['github', 'gitlab', 'gitee'] as const) {
    const providerConfig = oauthProviders()[provider];
    app.get(
      `/auth/${provider}`,
      { config: { rateLimit: AUTH_RATE_LIMIT } },
      oauthLoginHandler(provider, providerConfig),
    );
    app.get(
      `/auth/${provider}/callback`,
      { config: { rateLimit: AUTH_RATE_LIMIT } },
      oauthCallbackHandler(provider, providerConfig),
    );
  }
};

// Re-exports so existing consumers (tests) keep a single import site.
export {
  buildAuthorizeUrl,
  generatePkce,
  githubAppClientIdError,
  oauthProviders,
  signState,
  tokenRequestBody,
  verifyState,
} from './auth-oauth.js';

export default authRoutes;
