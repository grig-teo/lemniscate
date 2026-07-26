import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// REAL-Postgres integration test for the proposal auto-start claim. The
// mocked unit tests (tests/proposal-scheduler.test.ts) can only simulate the
// serialization pg_advisory_xact_lock provides — this suite proves it: two
// (or four) concurrent claimers must NEVER both claim the same proposal, and
// a claimed proposal blocks later claims (queued = active).
//
// Run locally:  docker compose up -d postgres && prisma migrate deploy
//               INTEGRATION=1 DATABASE_URL=postgresql://... npx vitest run tests/proposal-claim.integration.test.ts
// Run in CI:    the 'integration' job in .github/workflows/ci.yml provides a
//               postgres:16 service and sets INTEGRATION=1 + DATABASE_URL.
//
// Mutation check: commenting out the pg_advisory_xact_lock line in
// proposal-scheduler.ts makes the race test fail (both claimers pass the
// "no active proposal" check before either commits).

const RUN = process.env.INTEGRATION === '1';

// Dynamic imports inside beforeAll: module load pulls in config (env
// validation) and the prisma singleton, which should only happen when the
// suite actually runs against a real database.
let prisma: import('@prisma/client').PrismaClient;
let claimNextProposal: (repositoryId: string) => Promise<string | null>;

let userId: string;
let repositoryId: string;

describe.skipIf(!RUN)('claimNextProposal race (real Postgres)', () => {
  beforeAll(async () => {
    ({ prisma } = await import('../src/lib/prisma.js'));
    ({ claimNextProposal } = await import('../src/lib/proposal-scheduler.js'));

    const user = await prisma.user.create({ data: {} });
    userId = user.id;
    const connection = await prisma.gitConnection.create({
      data: { userId, provider: 'github', username: `race-tester-${userId}` },
    });
    const repository = await prisma.repository.create({
      data: {
        connectionId: connection.id,
        externalId: `race-repo-${userId}`,
        name: 'race-repo',
        fullName: 'race/race-repo',
        cloneUrl: 'https://example.com/race/race-repo.git',
        defaultBranch: 'main',
      },
    });
    repositoryId = repository.id;
  }, 30_000);

  afterAll(async () => {
    if (!userId) return;
    await prisma.user.delete({ where: { id: userId } }); // cascades everything
    await prisma.$disconnect();
  });

  async function clearTasks() {
    await prisma.task.deleteMany({ where: { repositoryId } });
  }

  async function seedPending(title: string, createdAt?: Date) {
    const task = await prisma.task.create({
      data: { repositoryId, kind: 'proposal', title, status: 'pending', ...(createdAt ? { createdAt } : {}) },
    });
    return task.id;
  }

  it('two concurrent claimers cannot both claim the same proposal', async () => {
    await clearTasks();
    const proposalId = await seedPending('race me');

    const [first, second] = await Promise.all([
      claimNextProposal(repositoryId),
      claimNextProposal(repositoryId),
    ]);

    expect([first, second].filter(Boolean)).toEqual([proposalId]);
    // The winner flipped it to 'queued'.
    const after = await prisma.task.findUniqueOrThrow({ where: { id: proposalId } });
    expect(after.status).toBe('queued');
  });

  it('four concurrent claimers resolve to exactly one claim', async () => {
    await clearTasks();
    await seedPending('race me x4');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => claimNextProposal(repositoryId)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  // The advisory-lock case: with SEVERAL pending proposals there is a real
  // window (claimer B's active-count runs before claimer A commits, but B's
  // findFirst runs after — B sees 0 active AND picks a different row, so the
  // conditional updateMany cannot save it). Only the per-repository lock
  // serializing the whole check+claim keeps the one-active-proposal-per-repo
  // invariant. A single round hits the window only sporadically (measured
  // ~60% at width 8 without the lock), so the test loops: with the lock every
  // round claims exactly one; without it a violation is statistically
  // certain. Verified by commenting out pg_advisory_xact_lock — this test
  // fails (multiple claims in one round).
  it('concurrent claimers with several pending proposals start exactly ONE per round', async () => {
    const ROUNDS = 10;
    const WIDTH = 8;
    for (let round = 0; round < ROUNDS; round += 1) {
      await clearTasks();
      for (let i = 0; i < WIDTH; i += 1) await seedPending(`round ${round} candidate ${i}`);

      const results = await Promise.all(
        Array.from({ length: WIDTH }, () => claimNextProposal(repositoryId)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      const queued = await prisma.task.count({ where: { repositoryId, status: 'queued' } });
      expect(queued).toBe(1);
    }
  }, 60_000);

  it('a queued proposal counts as active — no second claim while it waits', async () => {
    await clearTasks();
    await seedPending('first');
    await seedPending('second');

    expect(await claimNextProposal(repositoryId)).not.toBeNull();
    expect(await claimNextProposal(repositoryId)).toBeNull();
  });

  it('claims the OLDEST pending proposal first', async () => {
    await clearTasks();
    const newer = await seedPending('newer', new Date('2026-01-02T00:00:00Z'));
    const older = await seedPending('older', new Date('2026-01-01T00:00:00Z'));

    expect(await claimNextProposal(repositoryId)).toBe(older);

    await prisma.task.update({ where: { id: older }, data: { status: 'closed' } });
    expect(await claimNextProposal(repositoryId)).toBe(newer);
  });

  it('never resurrects a proposal cancelled between select and claim', async () => {
    await clearTasks();
    const proposalId = await seedPending('cancel me');
    // Simulate the user closing the proposal before the scheduler claims it:
    // the conditional updateMany (id + still-pending) must match 0 rows.
    await prisma.task.update({ where: { id: proposalId }, data: { status: 'closed' } });

    expect(await claimNextProposal(repositoryId)).toBeNull();
    const after = await prisma.task.findUniqueOrThrow({ where: { id: proposalId } });
    expect(after.status).toBe('closed');
  });
});
