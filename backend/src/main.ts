import { config } from './config.js';
import { buildApp } from './app.js';

const app = await buildApp();

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
