import { defineConfig } from 'vitest/config';

// Minimal valid environment so modules importing src/config.ts (which calls
// process.exit on invalid env) can be loaded in tests. No real services are
// contacted: unit tests only exercise pure helpers and mocked fetch.
export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      FRONTEND_URL: 'http://localhost:8080',
      BACKEND_URL: 'http://localhost:3000',
      OAUTH_CALLBACK_URL: 'http://localhost:3000/api/auth',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-jwt-secret',
      ENCRYPTION_KEY: '0'.repeat(64),
    },
  },
});
