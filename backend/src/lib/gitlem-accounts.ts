import { createHash, randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.js';
import { encrypt } from './crypto.js';
import { DeliveryError, sendEmail } from './notification-email.js';
import { NOTIFICATION_KINDS, notify } from './notifications.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { prisma } from './prisma.js';

// gitlem account lifecycle: registration codes, account creation, and the
// "ensure" path that lazily provisions a gitlem account for a logged-in
// lemniscate user (and notifies them). Single home for the GitlemUser +
// GitConnection pair creation (AGENTS.md §6): every path that links a
// gitlem account to a user funnels through linkGitlemConnection().

export const GITLEM_CODE_TTL_MS = 10 * 60 * 1000;

export function gitlemCloneBase(): string {
  return `${config.BACKEND_URL.replace(/\/$/, '')}/api/gitlem/git`;
}

export function gitlemUsernameForEmail(email: string): string {
  const local = email.split('@')[0] ?? 'user';
  const base = local.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'user';
  return base.slice(0, 30);
}

function codeDigest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Create and email a 6-digit registration code; replaces any previous one. */
export async function issueRegistrationCode(email: string): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.gitlemRegistrationCode.deleteMany({ where: { email } });
  await prisma.gitlemRegistrationCode.create({
    data: {
      email,
      codeHash: codeDigest(code),
      expiresAt: new Date(Date.now() + GITLEM_CODE_TTL_MS),
    },
  });
  await sendEmail(email, {
    title: 'Your gitlem registration code',
    body: `Your gitlem verification code is: ${code}\n\nIt expires in 10 minutes.`,
  });
}

/** Consume a valid code for the email; deletes expired/used rows. */
export async function consumeRegistrationCode(email: string, code: string): Promise<boolean> {
  const row = await prisma.gitlemRegistrationCode.findFirst({
    where: { email },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return false;
  if (row.expiresAt.getTime() < Date.now()) {
    await prisma.gitlemRegistrationCode.delete({ where: { id: row.id } });
    return false;
  }
  if (row.codeHash !== codeDigest(code)) return false;
  await prisma.gitlemRegistrationCode.delete({ where: { id: row.id } });
  return true;
}

async function uniqueUsername(base: string): Promise<string> {
  let candidate = base;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const existing = await prisma.gitlemUser.findUnique({ where: { username: candidate } });
    if (!existing) return candidate;
    candidate = `${base}-${randomBytes(2).toString('hex')}`;
  }
  throw new Error('Could not allocate a gitlem username');
}

export interface GitlemAccountResult {
  gitlemUserId: string;
  username: string;
  apiToken: string;
  password: string;
}

/** Create the gitlem account row (caller checked the email is free). */
export async function createGitlemAccount(email: string, password: string): Promise<GitlemAccountResult> {
  const apiToken = `gitlem_${randomBytes(24).toString('hex')}`;
  const gitlemUser = await prisma.gitlemUser.create({
    data: {
      email,
      username: await uniqueUsername(gitlemUsernameForEmail(email)),
      passwordHash: hashPassword(password),
      apiToken,
    },
  });
  return { gitlemUserId: gitlemUser.id, username: gitlemUser.username, apiToken, password };
}

/**
 * Link a gitlem account to a lemniscate user: sets GitlemUser.userId and
 * upserts the provider 'gitlem' GitConnection holding the encrypted PAT.
 * Returns the connection id.
 */
export async function linkGitlemConnection(
  userId: string,
  gitlemUserId: string,
  username: string,
  apiToken: string,
): Promise<string> {
  await prisma.gitlemUser.update({ where: { id: gitlemUserId }, data: { userId } });
  const baseUrl = gitlemCloneBase();
  const existing = await prisma.gitConnection.findUnique({
    where: { provider_username_baseUrl: { provider: 'gitlem', username, baseUrl } },
  });
  if (existing) {
    await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { userId, accessTokenEnc: encrypt(apiToken), disconnectedAt: null },
    });
    return existing.id;
  }
  const connection = await prisma.gitConnection.create({
    data: {
      userId,
      provider: 'gitlem',
      username,
      baseUrl,
      accessTokenEnc: encrypt(apiToken),
      tokenType: 'pat',
    },
  });
  return connection.id;
}

/** The user's gitlem account, if they already have one. */
export async function findGitlemAccountForUser(userId: string) {
  return prisma.gitlemUser.findUnique({ where: { userId } });
}

/** Email+password sign-in against the gitlem account table. */
export async function authenticateGitlem(
  email: string,
  password: string,
): Promise<{ id: string; username: string; userId: string | null } | null> {
  const account = await prisma.gitlemUser.findUnique({ where: { email } });
  if (!account) return null;
  if (!verifyPassword(password, account.passwordHash)) return null;
  return { id: account.id, username: account.username, userId: account.userId };
}

/**
 * Make sure the user has an enabled 'email' notification channel pointing
 * at the given address, so gitlem emails also flow through the standard
 * delivery pipeline (and show up in notification settings).
 */
export async function ensureEmailChannel(userId: string, email: string): Promise<void> {
  const existing = await prisma.notificationSetting.findFirst({
    where: { userId, channel: 'email', target: email },
  });
  if (existing) {
    if (!existing.enabled) {
      await prisma.notificationSetting.update({
        where: { id: existing.id },
        data: { enabled: true },
      });
    }
    return;
  }
  await prisma.notificationSetting.create({
    data: { userId, channel: 'email', target: email, events: [...NOTIFICATION_KINDS] },
  });
}

export function generateGitlemPassword(): string {
  return randomBytes(9).toString('base64url');
}

async function emailCredentials(email: string, password: string): Promise<void> {
  await sendEmail(email, {
    title: 'Your gitlem account credentials',
    body: [
      'An account on gitlem (the internal git host) was created for you.',
      '',
      `Email: ${email}`,
      `Password: ${password}`,
      '',
      'Sign in from the lemniscate login page via "Connect gitlem".',
    ].join('\n'),
  });
}

/**
 * Lazily provision a gitlem account for a logged-in lemniscate user who has
 * none: generates a password, emails the credentials (best effort — an
 * unconfigured SMTP never blocks account creation) and posts an internal
 * notification. Existing accounts are returned as-is (created = false).
 */
export async function ensureGitlemAccountForUser(
  userId: string,
  email: string,
): Promise<{ created: boolean; username: string; emailed: boolean }> {
  const existing = await findGitlemAccountForUser(userId);
  if (existing) return { created: false, username: existing.username, emailed: false };

  // The email may already own a standalone gitlem account (registered via
  // the emailed code before ever logging into lemniscate) — link it instead
  // of failing on the unique email constraint.
  const byEmail = await prisma.gitlemUser.findUnique({ where: { email } });
  if (byEmail) {
    await linkGitlemConnection(userId, byEmail.id, byEmail.username, byEmail.apiToken);
    return { created: false, username: byEmail.username, emailed: false };
  }

  await ensureEmailChannel(userId, email);
  const password = generateGitlemPassword();
  const account = await createGitlemAccount(email, password);
  await linkGitlemConnection(userId, account.gitlemUserId, account.username, account.apiToken);

  let emailed = true;
  try {
    await emailCredentials(email, password);
  } catch (err) {
    emailed = false;
    if (!(err instanceof DeliveryError)) throw err;
  }
  await notify(userId, 'gitlem_account_created', {
    title: 'gitlem account created',
    body: emailed
      ? `An account on gitlem was created for you (${account.username}). The credentials were sent to ${email}.`
      : `An account on gitlem was created for you (${account.username}), but the credentials email could not be sent (SMTP is not configured).`,
  });
  return { created: true, username: account.username, emailed };
}
