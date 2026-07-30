import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  authenticateGitlem,
  consumeRegistrationCode,
  createGitlemAccount,
  ensureEmailChannel,
  ensureGitlemAccountForUser,
  findGitlemAccountForUser,
  generateGitlemPassword,
  issueRegistrationCode,
  linkGitlemConnection,
} from '../lib/gitlem-accounts.js';
import { DeliveryError, sendEmail } from '../lib/notification-email.js';
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

async function registerHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(registerBodySchema, request.body, reply, 'Invalid registration payload');
  if (!body) return;
  const taken = await prisma.gitlemUser.findUnique({ where: { email: body.email } });
  if (taken) {
    return reply.code(409).send({ error: 'A gitlem account with this email already exists' });
  }
  if (!(await consumeRegistrationCode(body.email, body.code))) {
    return reply.code(400).send({ error: 'Invalid or expired registration code' });
  }
  const password = body.password ?? generateGitlemPassword();
  const account = await createGitlemAccount(body.email, password);
  const userId = await userForGitlemAccount({ userId: null });
  await ensureEmailChannel(userId, body.email);
  const connectionId = await linkGitlemConnection(
    userId,
    account.gitlemUserId,
    account.username,
    account.apiToken,
  );
  await notifyCredentialsEmail(userId, body.email, password, body.password === undefined);
  return finishGitlemLogin(userId, connectionId, request, reply);
}

// Registration without a chosen password emails the generated one (the
// "send password to his email" flow) and notes it in the internal bell.
async function notifyCredentialsEmail(
  userId: string,
  email: string,
  password: string,
  generated: boolean,
): Promise<void> {
  if (!generated) return;
  const { notify } = await import('../lib/notifications.js');
  try {
    await sendEmail(email, {
      title: 'Your gitlem account credentials',
      body: `Your gitlem account was created.\n\nEmail: ${email}\nPassword: ${password}`,
    });
    await notify(userId, 'gitlem_account_created', {
      title: 'gitlem account created',
      body: `Your gitlem account was created and the credentials were sent to ${email}.`,
    });
  } catch (err) {
    if (!(err instanceof DeliveryError)) throw err;
  }
}

export async function ensureAccountHandler(request: FastifyRequest, reply: FastifyReply) {
  const userId = request.userId;
  if (!userId) return reply.code(401).send({ error: 'Authentication required' });
  // A connected user never needs the email channel — check first so a user
  // without one can still open the repos pane / create-repo modal.
  const existing = await findGitlemAccountForUser(userId);
  if (existing) {
    return reply.code(200).send({ created: false, username: existing.username, emailed: false });
  }
  const email = await resolveUserEmail(userId);
  if (!email) {
    return reply.code(400).send({
      error: 'Set up an email notification channel first so gitlem can send your credentials',
    });
  }
  const result = await ensureGitlemAccountForUser(userId, email);
  return reply.code(200).send(result);
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
