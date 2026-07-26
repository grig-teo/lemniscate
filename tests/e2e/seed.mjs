// Seeds the e2e database state from INSIDE the running backend container
// (docker compose exec backend node /e2e/seed.mjs), using the real compiled
// code — the same Prisma client and AES-256-GCM encryption the API uses.
//
// Why seeding is needed: PAT connect doubles as login but never creates
// accounts (connectByPatIdentity rejects unknown identities with 401, and
// first-time registration otherwise goes through real OAuth). So the suite
// seeds exactly one user plus its pre-existing gitverse connection identity
// (username e2e-user, baseUrl https://gitstub), then the smoke test performs
// the real PAT-connect login against the stub provider.
//
// Prints one JSON line: {"userId","connectionId"} — consumed by run.sh.

import { prisma } from '/app/dist/lib/prisma.js';
import { encrypt } from '/app/dist/lib/crypto.js';

const E2E_USERNAME = 'e2e-user';
const E2E_BASE_URL = process.env.E2E_GIT_BASE_URL ?? 'https://gitstub';
const E2E_SEED_TOKEN = process.env.E2E_GIT_TOKEN ?? 'e2e-seed-token';

const user = await prisma.user.create({ data: {} });
const connection = await prisma.gitConnection.create({
  data: {
    userId: user.id,
    provider: 'gitverse',
    baseUrl: E2E_BASE_URL,
    username: E2E_USERNAME,
    accessTokenEnc: encrypt(E2E_SEED_TOKEN),
    tokenType: 'pat',
  },
});

console.log(JSON.stringify({ userId: user.id, connectionId: connection.id }));
await prisma.$disconnect();
