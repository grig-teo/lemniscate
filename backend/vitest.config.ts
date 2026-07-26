import { defineConfig } from 'vitest/config';

// Minimal valid environment so modules importing src/config.ts (which calls
// process.exit on invalid env) can be loaded in tests. No real services are
// contacted: unit tests only exercise pure helpers and mocked fetch.
// DATABASE_URL defers to the shell env when set so the INTEGRATION=1 suite
// (tests/proposal-claim.integration.test.ts) can point at a real Postgres —
// vitest's test.env otherwise overrides process.env.
export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      FRONTEND_URL: 'http://localhost:8080',
      BACKEND_URL: 'http://localhost:3000',
      OAUTH_CALLBACK_URL: 'http://localhost:3000/api/auth',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:***@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-jwt-secret-padded-to-32-chars!',
      ENCRYPTION_KEY: '0'.repeat(64),
      GITHUB_CLIENT_ID: 'Ov23liAbCdEf123456',
      GITHUB_CLIENT_SECRET: 'test-github-client-secret',
      // Lets app-level tests exercise the guarded /metrics endpoint.
      METRICS_TOKEN: 'test-metrics-token',
    },
  },
});
