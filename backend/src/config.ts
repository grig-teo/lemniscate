import { existsSync } from 'node:fs';
import process from 'node:process';
import { z } from 'zod';

// Load `backend/.env` in local dev. In Docker, compose injects env vars
// directly and no .env file is present. Uses Node 22's built-in env-file
// support, so no dotenv dependency is needed.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const envSchema = z.object({
  // --- Server ---
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  // --- URLs ---
  FRONTEND_URL: z.string().url(),
  BACKEND_URL: z.string().url(),
  OAUTH_CALLBACK_URL: z.string().url(),

  // --- Database / Redis ---
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // --- Security ---
  JWT_SECRET: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  // --- GitHub OAuth ---
  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,

  // --- GitVerse OAuth ---
  GITVERSE_CLIENT_ID: optionalString,
  GITVERSE_CLIENT_SECRET: optionalString,
  GITVERSE_BASE_URL: z.string().url().default('https://gitverse.ru'),

  // --- GitLab OAuth ---
  GITLAB_CLIENT_ID: optionalString,
  GITLAB_CLIENT_SECRET: optionalString,

  // --- Gitee OAuth ---
  GITEE_CLIENT_ID: optionalString,
  GITEE_CLIENT_SECRET: optionalString,

  // --- MinIO (library object storage: skills / agents-md / mcp-servers) ---
  // Optional: when unset, library mirroring is a no-op (local dev without MinIO).
  MINIO_ENDPOINT: optionalString,
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_ROOT_USER: optionalString,
  MINIO_ROOT_PASSWORD: optionalString,
  MINIO_BUCKET: z.string().min(1).default('lemniscate-library'),

  // --- Agent loop ---
  AGENT_WORKDIR: z.string().min(1).default('/tmp/lemniscate-repos'),
  AGENT_BRANCH_PREFIX: z.string().min(1).default('lemniscate/'),
  // How many jobs the worker runs in parallel (tasks are I/O-bound: clones
  // and LLM calls), so several repos can be processed at once.
  AGENT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Task executor: 'hermes' runs the Hermes Agent CLI inside the cloned repo;
  // 'internal' uses the built-in single-shot LLM propose/apply loop.
  AGENT_EXECUTOR: z.enum(['hermes', 'internal']).default('hermes'),
  // Hard kill for one `hermes chat` run; the job then fails the task.
  AGENT_HERMES_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(45),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
