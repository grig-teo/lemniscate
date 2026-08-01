import { createHash, randomInt } from 'node:crypto';
import { sendEmail } from './notification-email.js';
import { prisma } from './prisma.js';

// gitlem registration codes: create, email, and consume the one-time 6-digit
// codes that gate gitlem account registration/login. Extracted from
// gitlem-accounts.ts so each module stays under the 300-line limit
// (AGENTS.md §2); this is the single home for the code lifecycle (§6).

export const GITLEM_CODE_TTL_MS = 10 * 60 * 1000;
export const GITLEM_CODE_MAX_ATTEMPTS = 5;

// Failed code-verification attempts per email; the code is invalidated
// after GITLEM_CODE_MAX_ATTEMPTS misses (brute-force guard). The code row
// has no counter column, so this is process-local — sufficient alongside
// the per-route rate limit, and a restart only resets the counter.
const failedCodeAttempts = new Map<string, number>();

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
    await prisma.gitlemRegistrationCode.deleteMany({ where: { id: row.id } });
    return false;
  }
  if (row.codeHash !== codeDigest(code)) return recordFailedCodeAttempt(email, row.id);
  // Atomic consume: only the first of two concurrent registrations with the
  // same code deletes the row — the loser sees count 0 instead of a 500.
  const { count } = await prisma.gitlemRegistrationCode.deleteMany({
    where: { id: row.id, codeHash: row.codeHash },
  });
  if (count === 0) return false;
  failedCodeAttempts.delete(email);
  return true;
}

/** Count a wrong code; invalidate (delete) the row at the attempt limit. */
async function recordFailedCodeAttempt(email: string, rowId: string): Promise<boolean> {
  const attempts = (failedCodeAttempts.get(email) ?? 0) + 1;
  if (attempts < GITLEM_CODE_MAX_ATTEMPTS) {
    failedCodeAttempts.set(email, attempts);
    return false;
  }
  failedCodeAttempts.delete(email);
  await prisma.gitlemRegistrationCode.deleteMany({ where: { id: rowId } });
  return false;
}
