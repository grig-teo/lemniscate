import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for lib/gitlem-accounts.ts: atomic registration-code consume
// (expiry, brute-force attempt limit), the ensure-account flow that must
// never link a gitlem account to a different lemniscate user by email
// alone, unique-email race handling, and login timing hardening.
// prisma, email delivery, notifications and crypto are mocked.

const mocks = vi.hoisted(() => ({
  codeFindFirst: vi.fn(),
  codeDeleteMany: vi.fn(),
  codeCreate: vi.fn(),
  gitlemUserFindUnique: vi.fn(),
  gitlemUserCreate: vi.fn(),
  gitlemUserUpdate: vi.fn(),
  connectionFindUnique: vi.fn(),
  connectionFindFirst: vi.fn(),
  connectionCreate: vi.fn(),
  connectionUpdate: vi.fn(),
  settingFindFirst: vi.fn(),
  settingCreate: vi.fn(),
  settingUpdate: vi.fn(),
  sendEmail: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    gitlemRegistrationCode: {
      findFirst: mocks.codeFindFirst,
      deleteMany: mocks.codeDeleteMany,
      create: mocks.codeCreate,
    },
    gitlemUser: {
      findUnique: mocks.gitlemUserFindUnique,
      create: mocks.gitlemUserCreate,
      update: mocks.gitlemUserUpdate,
    },
    gitConnection: {
      findUnique: mocks.connectionFindUnique,
      findFirst: mocks.connectionFindFirst,
      create: mocks.connectionCreate,
      update: mocks.connectionUpdate,
    },
    notificationSetting: {
      findFirst: mocks.settingFindFirst,
      create: mocks.settingCreate,
      update: mocks.settingUpdate,
    },
  },
}));

vi.mock('../src/lib/notification-email.js', () => ({
  DeliveryError: class DeliveryError extends Error {},
  sendEmail: mocks.sendEmail,
}));

vi.mock('../src/lib/notifications.js', () => ({
  NOTIFICATION_KINDS: ['test_kind'],
  notify: mocks.notify,
}));

vi.mock('../src/lib/crypto.js', () => ({
  encrypt: (value: string) => `enc:${value}`,
}));

import {
  authenticateGitlem,
  consumeRegistrationCode,
  createGitlemAccount,
  emailGeneratedCredentials,
  ensureGitlemAccountForUser,
  GITLEM_CODE_MAX_ATTEMPTS,
  GitlemAccountConflictError,
  GitlemEmailTakenError,
} from '../src/lib/gitlem-accounts.js';
import { hashPassword } from '../src/lib/passwords.js';

function codeDigest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function codeRow(email: string, code: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `row-${email}`,
    email,
    codeHash: codeDigest(code),
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.codeDeleteMany.mockResolvedValue({ count: 1 });
  mocks.settingFindFirst.mockResolvedValue(null);
  mocks.connectionFindUnique.mockResolvedValue(null);
  mocks.connectionFindFirst.mockResolvedValue(null);
  mocks.connectionCreate.mockResolvedValue({ id: 'conn-1' });
  // Default happy path: email delivery succeeds. Tests that need a delivery
  // failure override this with mockRejectedValue (clearAllMocks only clears
  // call history, not implementations, so a prior rejection would otherwise
  // leak into later tests and skip the notify step).
  mocks.sendEmail.mockResolvedValue(undefined);
});

describe('consumeRegistrationCode', () => {
  it('consumes a valid code atomically by id+hash', async () => {
    mocks.codeFindFirst.mockResolvedValue(codeRow('atomic@example.com', '123456'));
    await expect(consumeRegistrationCode('atomic@example.com', '123456')).resolves.toBe(true);
    expect(mocks.codeDeleteMany).toHaveBeenCalledWith({
      where: { id: 'row-atomic@example.com', codeHash: codeDigest('123456') },
    });
  });

  it('loses the race when a concurrent consume already deleted the row', async () => {
    mocks.codeFindFirst.mockResolvedValue(codeRow('race@example.com', '123456'));
    mocks.codeDeleteMany.mockResolvedValue({ count: 0 });
    await expect(consumeRegistrationCode('race@example.com', '123456')).resolves.toBe(false);
  });

  it('rejects and removes an expired code', async () => {
    mocks.codeFindFirst.mockResolvedValue(
      codeRow('expired@example.com', '123456', { expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(consumeRegistrationCode('expired@example.com', '123456')).resolves.toBe(false);
    expect(mocks.codeDeleteMany).toHaveBeenCalledWith({ where: { id: 'row-expired@example.com' } });
  });

  it('returns false when no code was issued for the email', async () => {
    mocks.codeFindFirst.mockResolvedValue(null);
    await expect(consumeRegistrationCode('none@example.com', '123456')).resolves.toBe(false);
    expect(mocks.codeDeleteMany).not.toHaveBeenCalled();
  });

  it('invalidates the code after the failed-attempt limit', async () => {
    const email = 'brute@example.com';
    mocks.codeFindFirst.mockResolvedValue(codeRow(email, '123456'));
    for (let attempt = 0; attempt < GITLEM_CODE_MAX_ATTEMPTS; attempt += 1) {
      await expect(consumeRegistrationCode(email, '000000')).resolves.toBe(false);
    }
    expect(mocks.codeDeleteMany).toHaveBeenCalledWith({ where: { id: `row-${email}` } });
    // Once invalidated the row is gone, so even the real code no longer works.
    mocks.codeFindFirst.mockResolvedValue(null);
    await expect(consumeRegistrationCode(email, '123456')).resolves.toBe(false);
  });

  it('does not invalidate the code below the attempt limit', async () => {
    const email = 'patient@example.com';
    mocks.codeFindFirst.mockResolvedValue(codeRow(email, '123456'));
    for (let attempt = 0; attempt < GITLEM_CODE_MAX_ATTEMPTS - 1; attempt += 1) {
      await consumeRegistrationCode(email, '000000');
    }
    expect(mocks.codeDeleteMany).not.toHaveBeenCalled();
    await expect(consumeRegistrationCode(email, '123456')).resolves.toBe(true);
  });
});

describe('createGitlemAccount', () => {
  it('maps a unique-constraint race on create to GitlemEmailTakenError', async () => {
    mocks.gitlemUserFindUnique.mockResolvedValue(null); // username is free
    mocks.gitlemUserCreate.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    await expect(createGitlemAccount('taken@example.com', 'password-1')).rejects.toBeInstanceOf(
      GitlemEmailTakenError,
    );
  });

  it('rethrows non-unique create failures', async () => {
    mocks.gitlemUserFindUnique.mockResolvedValue(null);
    mocks.gitlemUserCreate.mockRejectedValue(new Error('db down'));
    await expect(createGitlemAccount('x@example.com', 'password-1')).rejects.toThrow('db down');
  });
});

describe('ensureGitlemAccountForUser', () => {
  it('refuses to link an account owned by a different user', async () => {
    mocks.gitlemUserFindUnique.mockImplementation(async ({ where }: { where: { userId?: string; email?: string } }) => {
      if (where.userId) return null;
      if (where.email) {
        return { id: 'gu-victim', email: where.email, username: 'victim', apiToken: 'tok', userId: 'victim-user' };
      }
      return null;
    });
    await expect(
      ensureGitlemAccountForUser('attacker-user', 'victim@example.com'),
    ).rejects.toBeInstanceOf(GitlemAccountConflictError);
    // The link path must not run: no takeover of GitlemUser.userId, no PAT handover.
    expect(mocks.gitlemUserUpdate).not.toHaveBeenCalled();
    expect(mocks.connectionCreate).not.toHaveBeenCalled();
    expect(mocks.connectionUpdate).not.toHaveBeenCalled();
    expect(mocks.gitlemUserCreate).not.toHaveBeenCalled();
  });

  it('links an existing account that already belongs to the same user', async () => {
    mocks.gitlemUserFindUnique.mockImplementation(async ({ where }: { where: { userId?: string; email?: string } }) => {
      if (where.userId) return null;
      if (where.email) {
        return { id: 'gu-1', email: where.email, username: 'ann', apiToken: 'tok', userId: 'user-1' };
      }
      return null;
    });
    const result = await ensureGitlemAccountForUser('user-1', 'ann@example.com');
    expect(result).toEqual({ created: false, username: 'ann', emailed: false });
    expect(mocks.gitlemUserUpdate).toHaveBeenCalledWith({
      where: { id: 'gu-1' },
      data: { userId: 'user-1' },
    });
    expect(mocks.connectionCreate).toHaveBeenCalled();
    expect(mocks.gitlemUserCreate).not.toHaveBeenCalled();
  });

  it('returns the existing account untouched when the user already has one', async () => {
    mocks.gitlemUserFindUnique.mockResolvedValue({ id: 'gu-1', username: 'ann', userId: 'user-1' });
    const result = await ensureGitlemAccountForUser('user-1', 'ann@example.com');
    expect(result).toEqual({ created: false, username: 'ann', emailed: false });
    expect(mocks.gitlemUserCreate).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('provisions a fresh account and emails the credentials', async () => {
    mocks.gitlemUserFindUnique.mockResolvedValue(null);
    mocks.gitlemUserCreate.mockImplementation(async ({ data }: { data: { username: string } }) => ({
      id: 'gu-new',
      ...data,
    }));
    const result = await ensureGitlemAccountForUser('user-1', 'new@example.com');
    expect(result.created).toBe(true);
    expect(result.emailed).toBe(true);
    expect(mocks.gitlemUserCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      'new@example.com',
      expect.objectContaining({ title: 'Your gitlem account credentials' }),
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      'user-1',
      'gitlem_account_created',
      expect.objectContaining({ title: 'gitlem account created' }),
    );
  });

  it('still provisions when the credentials email cannot be delivered', async () => {
    const { DeliveryError } = await import('../src/lib/notification-email.js');
    mocks.gitlemUserFindUnique.mockResolvedValue(null);
    mocks.gitlemUserCreate.mockImplementation(async ({ data }: { data: { username: string } }) => ({
      id: 'gu-new',
      ...data,
    }));
    mocks.sendEmail.mockRejectedValue(new DeliveryError('smtp not configured'));
    const result = await ensureGitlemAccountForUser('user-1', 'new@example.com');
    expect(result.created).toBe(true);
    expect(result.emailed).toBe(false);
  });
});

describe('authenticateGitlem', () => {
  it('returns null for an unknown email', async () => {
    mocks.gitlemUserFindUnique.mockResolvedValue(null);
    await expect(authenticateGitlem('ghost@example.com', 'pw')).resolves.toBeNull();
  });

  it('authenticates a valid email+password', async () => {
    mocks.gitlemUserFindUnique.mockResolvedValue({
      id: 'gu-1',
      username: 'ann',
      userId: 'user-1',
      passwordHash: hashPassword('secret-pw'),
    });
    await expect(authenticateGitlem('ann@example.com', 'secret-pw')).resolves.toEqual({
      id: 'gu-1',
      username: 'ann',
      userId: 'user-1',
    });
  });

  it('rejects a wrong password', async () => {
    mocks.gitlemUserFindUnique.mockResolvedValue({
      id: 'gu-1',
      username: 'ann',
      userId: 'user-1',
      passwordHash: hashPassword('secret-pw'),
    });
    await expect(authenticateGitlem('ann@example.com', 'nope')).resolves.toBeNull();
  });
});

describe('emailGeneratedCredentials', () => {
  it('emails the credentials and posts a notification', async () => {
    await emailGeneratedCredentials('user-1', 'x@example.com', 'pw');
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      'x@example.com',
      expect.objectContaining({ title: 'Your gitlem account credentials' }),
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      'user-1',
      'gitlem_account_created',
      expect.objectContaining({ title: 'gitlem account created' }),
    );
  });

  it('swallows delivery failures without notifying', async () => {
    const { DeliveryError } = await import('../src/lib/notification-email.js');
    mocks.sendEmail.mockRejectedValue(new DeliveryError('smtp not configured'));
    await expect(
      emailGeneratedCredentials('user-1', 'x@example.com', 'pw'),
    ).resolves.toBeUndefined();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
