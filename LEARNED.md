# Learned facts

- Frontend tests/build need dev deps; the sandbox sets `NODE_ENV=production`, so run with `env -u NODE_ENV npm ci` and `env -u NODE_ENV npx vitest run` / `env -u NODE_ENV npm run build`. (CI does not have this — it uses `npm ci` + `npm test` directly.)
