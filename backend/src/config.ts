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
  // Worker liveness endpoint (worker.ts): serves BullMQ job counts for the
  // compose healthcheck. Separate port so the API surface stays untouched.
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3100),
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
  // Long enough to resist brute force, and never the shipped placeholder.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine((value) => value !== 'change-me-to-a-long-random-string', {
      message: 'JWT_SECRET is still the shipped default — generate a random one',
    }),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  // Escape hatch for local dev: allow private/loopback URLs for LLM baseUrl
  // and git connections (SSRF guard in lib/url-safety.ts). Unset = blocked.
  ALLOW_PRIVATE_URLS: z.enum(['true', 'false']).optional(),
  // In Docker the backend is only reachable through the frontend nginx,
  // which sets X-Forwarded-For/X-Real-IP. Trusting the proxy makes
  // request.ip (and therefore every rate-limit bucket) reflect the real
  // client instead of nginx's container IP. Set to 'false' only if the
  // backend is ever exposed directly, where clients could spoof the header.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

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
  // Device build artifacts (APKs in the 'device-artifacts' bucket) are
  // transient: a bucket lifecycle rule expires them after this many days.
  DEVICE_ARTIFACT_TTL_DAYS: z.coerce.number().int().positive().default(7),
  // Max artifact uploads one device token may make per rolling 24h window
  // (Redis counter); the (N+1)th upload is rejected with 429.
  DEVICE_ARTIFACT_MAX_PER_DAY: z.coerce.number().int().positive().default(20),

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

  // --- Service deployments (Lemniscate Apps) ---
  // Shared secret between Traefik (HTTP provider) and the backend's
  // /api/internal/traefik/dynamic endpoint. Empty = endpoint disabled (503).
  TRAEFIK_PROVIDER_TOKEN: z.string().default(''),
  // Docker bridge network service containers join (isolated from platform
  // internals; Traefik is the only member shared with the platform).
  APPS_NETWORK: z.string().min(1).default('lemniscate-apps'),
  // Public base URL of the apps domain, for display in the UI.
  APPS_BASE_URL: z.string().default('https://apps.grig-teo.space'),
  // How Traefik reaches the backend (compose service name) — target of the
  // per-owner apps-index routers.
  TRAEFIK_BACKEND_URL: z.string().default('http://backend:3000'),
  // Resource limits applied to every service container.
  APPS_CONTAINER_MEMORY: z.string().min(1).default('512m'),
  APPS_CONTAINER_CPUS: z.string().min(1).default('1'),

  // --- Outbound email notifications (phase 2 channel; webhooks need none
  // of this). Unset SMTP_HOST = email channels are recorded as 'skipped'.
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_FROM: z.string().min(1).default('Lemniscate <notifications@localhost>'),

  // --- API limits ---
  // Queued+running tasks a single user may have at once; the 6th concurrent
  // create is rejected with 429.
  TASK_MAX_ACTIVE_PER_USER: z.coerce.number().int().positive().default(5),
  // Maximum TaskEvent rows retained per task. When exceeded, the oldest
  // events are truncated under an advisory lock with a boundary marker so
  // the table cannot grow without bound on long-running tasks.
  TASK_EVENT_MAX_PER_TASK: z.coerce.number().int().positive().default(5_000),

  // --- Observability ---
  // Bearer token guarding GET /metrics (Prometheus). Unset = the endpoint
  // answers 404, so it can never be exposed through the frontend proxy by
  // accident. Generate a random one and put it in the Prometheus scrape
  // config's authorization credentials (see docs/observability.md).
  METRICS_TOKEN: optionalString,
  // Opt-in Sentry error reporting for the API and worker. Unset = the SDK is
  // never imported and reporting is a no-op. Events are scrubbed of the
  // secrets below before leaving the process.
  SENTRY_DSN: optionalString,
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

// Values scrubbed from every Sentry event (lib/sentry.ts scrubEvent) before
// it leaves the process: anything that authenticates against our own
// dependencies. Per-user LLM keys are already redacted at their source
// (llm-client scrubs the apiKey out of every thrown error).
export const MONITORED_SECRETS: string[] = [
  config.JWT_SECRET,
  config.ENCRYPTION_KEY,
  config.DATABASE_URL,
  config.REDIS_URL,
];
