import type { FastifyPluginAsync } from 'fastify';
import { gitPassthroughParser, registerGitlemGitRoutes } from '../lib/gitlem-http.js';
import { requireAuth } from '../plugins/auth.js';
import { gitlemAccountRoutes, gitlemAuthRoutes } from './gitlem-auth.js';
import { gitlemRepoRoutes } from './gitlem-repos.js';

// HTTP surface of gitlem, the internal minimal git host:
//
//   POST /api/gitlem/login               email+password sign-in (sets the
//                                        lemniscate session cookie)
//   POST /api/gitlem/register/code       email a 6-digit registration code
//   POST /api/gitlem/register            consume the code, create account
//   POST /api/gitlem/ensure              lazy provisioning behind the '+'
//                                        card / create-repo modal (session)
//   GET|POST /api/gitlem/repos/...       details, branches, README, PRs, CI
//   *    /api/gitlem/git/<u>/<r>.git/... git-over-HTTP auth boundary
//
const gitlemRoutes: FastifyPluginAsync = async (app) => {
  await app.register(gitlemAuthRoutes);
  await app.register(async (authed) => {
    authed.addHook('preHandler', requireAuth);
    await authed.register(gitlemAccountRoutes);
    await authed.register(gitlemRepoRoutes);
  });
  await app.register(async (git) => {
    // receive-pack streams must bypass the JSON body parser (scoped).
    git.addContentTypeParser('*', gitPassthroughParser);
    registerGitlemGitRoutes(git);
  }, { prefix: '/git' });
};

export default gitlemRoutes;
