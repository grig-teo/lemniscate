# Learned

- The sandbox env sets `NODE_ENV=production`: `npm ci` skips devDependencies (no vite/vitest/tsc) and React resolves to the production build, breaking @testing-library (`act(...) is not supported`). Fix: `NODE_ENV=development npm ci --include=dev` and run tests with `NODE_ENV=test npx vitest run ...`.
