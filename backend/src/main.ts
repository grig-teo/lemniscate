import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import apiRoutes from './routes/index.js';
import llmConfigRoutes from './routes/llm-configs.js';
import skillsRoutes from './routes/skills.js';
import mcpServersRoutes from './routes/mcp-servers.js';
import libraryRoutes from './routes/library.js';
import tasksRoutes from './routes/tasks.js';

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

await app.register(cookie);
await app.register(cors, {
  origin: config.FRONTEND_URL,
  credentials: true,
});

// Global throttle; stricter per-route buckets live in `config.rateLimit` on
// the sensitive routes (auth, PAT connect, LLM test, task create).
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

// Auth, git connections, repositories (prefixed /api inside the plugin).
await app.register(apiRoutes);
await app.register(llmConfigRoutes, { prefix: '/api/llm-configs' });
await app.register(skillsRoutes, { prefix: '/api/skills' });
await app.register(mcpServersRoutes, { prefix: '/api/mcp-servers' });
await app.register(libraryRoutes, { prefix: '/api/library' });
// tasks.ts declares its routes as `/tasks...` (same convention as
// repositories.ts), so it mounts under /api, not /api/tasks.
await app.register(tasksRoutes, { prefix: '/api' });

app.get('/health', async () => ({ ok: true }));

// Graceful shutdown: stop accepting connections, then exit.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err, 'error during shutdown');
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
