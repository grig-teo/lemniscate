# Learned facts

- **Frontend tests need NODE_ENV != production.** The sandbox sets `NODE_ENV=production`, which makes npm skip devDependencies (so `vite`/`vitest` aren't installed) and loads React's production build (which breaks `act()` in tests). Workaround: `cd frontend && npm install --include=dev` then `NODE_ENV=test npx vitest run` (or `NODE_ENV=test npm test`).
- Frontend toggle icons use Tailwind sizing (`h-3.5 w-3.5` or `size-3.5`); 2x of 3.5 is 7 (`h-7 w-7` / `size-7`).
