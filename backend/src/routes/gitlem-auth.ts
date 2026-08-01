import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  authenticateGitlem,
  consumeRegistrationCode,
  createGitlemAccount,
  emailGeneratedCredentials,
  ensureEmailChannel,
  ensureGitlemAccountForUser,
  findGitlemAccountForUser,
  generateGitlemPassword,
  GitlemAccountConflictError,
  GitlemEmailTakenError,
  issueRegistrationCode,
  linkGitlemConnection,
} from '../lib/gitlem-accounts.js';
import { DeliveryError } from '../lib/notification-email.js';
import { syncConnectionByIdBestEffort } from '../lib/repo-sync.js';
import { prisma } from '../lib/prisma.js';
import { setAuthCookie } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// gitlem identity endpoints: email+password login, emailed-code
// registration, and the lazy "ensure account" endpoint that backs the
// gitlem pane's '+' card. Successful login/registration starts a lemniscate
// session (the gitlem account is the user's first git connection) and
// triggers the same best-effort repo sync as the OAuth flow.

// Login/registration endpoints are attacked like /auth/* — same bucket.
const GITLEM_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

const emailBodySchema = z.object({ email: z.string().email().max(320) });

const loginBodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

// Password is optional: when omitted, one is generated and emailed to the
// user (the "we send the password to your email" registration flow).
const registerBodySchema = z.object({
  email: z.string().email().max(320),
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(8).max(200).optional(),
});

// gitlem sign-in always needs a lemniscate User to hang the session and
// the GitConnection on: reuse the linked one or create a fresh identity.
async function userForGitlemAccount(account: { userId: string | null }): Promise<string> {
  if (account.userId) return account.userId;
  const user = await prisma.user.create({ data: {} });
  return user.id;
}

async function finishGitlemLogin(
  userId: string,
  connectionId: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  await setAuthCookie(reply, userId);
  // Same first-visit repo population as OAuth login; a failed sync must not
  // break the login.
  await syncConnectionByIdBestEffort(connectionId, request.log);
  return reply.code(200).send({ ok: true });
}

async function loginHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(loginBodySchema, request.body, reply, 'Invalid login payload');
  if (!body) return;
  const account = await authenticateGitlem(body.email, body.password);
  if (!account) return reply.code(401).send({ error: 'Invalid email or password' });
  const userId = await userForGitlemAccount(account);
  await ensureEmailChannel(userId, body.email);
  const gitlemUser = await prisma.gitlemUser.findUniqueOrThrow({ where: { id: account.id } });
  const connectionId = await linkGitlemConnection(
    userId,
    account.id,
    gitlemUser.username,
    gitlemUser.apiToken,
  );
  return finishGitlemLogin(userId, connectionId, request, reply);
}

async function requestCodeHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(emailBodySchema, request.body, reply, 'Invalid email');
  if (!body) return;
  try {
    await issueRegistrationCode(body.email);
  } catch (err) {
    if (err instanceof DeliveryError) {
      return reply.code(503).send({ error: 'Email delivery is not configured on this server' });
    }
    throw err;
  }
  return reply.code(200).send({ ok: true });
}

// One uniform answer for a bad code AND an already-registered email, and
// the code is always checked first: without a valid code the endpoint
// reveals nothing about which emails have accounts (no enumeration).
const REGISTER_ERROR = 'Invalid registration code or email already registered';

async function registerHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(registerBodySchema, request.body, reply, 'Invalid registration payload');
  if (!body) return;
  if (!(await consumeRegistrationCode(body.email, body.code))) {
    return reply.code(400).send({ error: REGISTER_ERROR });
  }
  const password = body.password ?? generateGitlemPassword();
  const account = await createAccountOrConflict(body.email, password, reply);
  if (!account) return;
  const userId = await userForGitlemAccount({ userId: null });
  await ensureEmailChannel(userId, body.email);
  const connectionId = await linkGitlemConnection(
    userId,
    account.gitlemUserId,
    account.username,
    account.apiToken,
  );
  if (body.password === undefined) {
    await emailGeneratedCredentials(userId, body.email, password);
  }
  return finishGitlemLogin(userId, connectionId, request, reply);
}

// A concurrent registration with the same email loses the unique race on
// create (P2002 → GitlemEmailTakenError); answer with the uniform error.
async function createAccountOrConflict(email: string, password: string, reply: FastifyReply) {
  try {
    return await createGitlemAccount(email, password);
  } catch (err) {
    if (!(err instanceof GitlemEmailTakenError)) throw err;
    await reply.code(409).send({ error: REGISTER_ERROR });
    return null;
  }
}

export async function ensureAccountHandler(request: FastifyRequest, reply: FastifyReply) {
  const userId = request.userId;
  if (!userId) return reply.code(401).send({ error: 'Authentication required' });
  // A connected user never needs the email channel — check first so a user
  // without one can still open the repos pane / create-repo modal. When the
  // account already exists, still re-link the GitConnection: a user who
  // disconnected gitlem in Settings has a soft-disconnected connection (token
  // scrubbed, disconnectedAt set), and reconnecting via the repos pane "+" or
  // Settings must restore it so repo create works again.
  const existing = await findGitlemAccountForUser(userId);
  if (existing) {
    await linkGitlemConnection(userId, existing.id, existing.username, existing.apiToken);
    return reply.code(200).send({ created: false, username: existing.username, emailed: false });
  }
  const email = await resolveUserEmail(userId);
  if (!email) {
    return reply.code(400).send({
      error: 'Set up an email notification channel first so gitlem can send your credentials',
    });
  }
  try {
    const result = await ensureGitlemAccountForUser(userId, email);
    return reply.code(200).send(result);
  } catch (err) {
    // Never link by email alone: the address belongs to another user's
    // gitlem account, so provisioning must conflict instead of taking over.
    if (!(err instanceof GitlemAccountConflictError)) throw err;
    return reply.code(409).send({
      error: 'This email already belongs to a different gitlem account',
    });
  }
}

// The lemniscate account itself has no email column — the user's enabled
// email notification channel is the address of record.
async function resolveUserEmail(userId: string): Promise<string | null> {
  const channel = await prisma.notificationSetting.findFirst({
    where: { userId, channel: 'email', enabled: true },
    orderBy: { createdAt: 'asc' },
  });
  return channel?.target ?? null;
}

export const gitlemAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post('/login', { config: { rateLimit: GITLEM_RATE_LIMIT } }, loginHandler);
  app.post('/register/code', { config: { rateLimit: GITLEM_RATE_LIMIT } }, requestCodeHandler);
  app.post('/register', { config: { rateLimit: GITLEM_RATE_LIMIT } }, registerHandler);
};

export const gitlemAccountRoutes: FastifyPluginAsync = async (app) => {
  app.post('/ensure', { config: { rateLimit: GITLEM_RATE_LIMIT } }, ensureAccountHandler);
};
