# LEARNED

- Deps: npm workspaces repo — run `npm install --include=dev` from the repo ROOT (backend/ has no own node_modules; vitest only exists after root install).
- Env quirk: `NODE_ENV=production` is set globally, so plain `npm ci` silently omits devDependencies — use `npm ci --include=dev`; it's an npm-workspaces repo, so deps land in the root `node_modules`, not `backend/node_modules`.
- Frontend tests need `NODE_ENV=test` (`cd frontend && NODE_ENV=test npm test`); otherwise React resolves to the production build and every @testing-library render fails with "act(...) is not supported in production builds of React".
- After changing `backend/prisma/schema.prisma`, run `npm run prisma:generate -w backend` before `typecheck`/tests — the generated client is not regenerated automatically in a fresh checkout.
- Run the repo's line guard per-package (`npm run check:max-lines` in backend/ and frontend/); running the root script across all dirs ignores the backend baseline file.
- The backend edit_file/multi_edit tools must reject a missing/blank `path` up-front (path-arg-guard.ts) — an empty path resolves to the workdir root and Node throws raw EISDIR.
