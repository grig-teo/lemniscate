# Contributing

See AGENTS.md for coding standards (function/class size limits, guard
clauses, single source of truth, and the Red → Green → Refactor loop). The
rules below are the enforcement points reviewers check before merge.

## Pipeline code ships with tests, or it does not ship

The autonomous pipeline (backend/src/lib/agent-run.ts, agent-review.ts,
merge-gate.ts, proposal-scheduler.ts, pr-state-sync.ts) decides what code
lands in users' repositories without human review. Any PR touching these
modules MUST include test changes in the same diff:

- **Unit/locking tests** in backend/tests/, in the established mocking style
  (vi.mock of prisma/queue/git/hermes-runner; real parsers left unmocked).
  Verdict parsing, attempt caps, re-enqueue job identity, and the
  record-then-rethrow failure paths are the required pinning points — the
  retry behavior must never be swallowed silently.
- **Integration tests** (backend/tests/*.integration.test.ts) run against a
  real Postgres behind `INTEGRATION=1`; they are skipped by default and run
  in the `integration` CI job (postgres:16 service, backend-path-filtered).
  Use them for behavior mocked transactions cannot prove (locking, races).

Run locally: `cd backend && npm run build && npm test`.
Integration: `docker compose up -d postgres && npx prisma migrate deploy`
then `INTEGRATION=1 DATABASE_URL=postgresql://... npx vitest run tests/proposal-claim.integration.test.ts`.


## Dependency updates

Automated dependency bumps come from [Dependabot](https://docs.github.com/code-security/dependabot)
(`.github/dependabot.yml`). It opens one PR per ecosystem per week (Monday,
UTC, staggered across hours): `backend/`, `frontend/`, `agent/`,
`agent-tauri/` (npm), `android/` (Gradle), the `backend/` and `frontend/`
Dockerfiles (docker), and the GitHub Actions in `/.github/workflows/`
(github-actions). Minor and patch updates are grouped into a single PR per
ecosystem; major updates stay individual because they may carry breaking
changes. Security advisories are always opened immediately — they do not wait
for the weekly schedule.

- Dependabot PRs follow the same Git workflow as any other change
  (AGENTS.md §8): one branch, one PR, merged only when CI is green.
- A second safety net, `npm audit --audit-level=high`, runs in the `backend`
  and `frontend` CI jobs and fails the build on a high/critical advisory even
  before Dependabot opens a PR. Moderate and below do not fail the build.
- **Major updates require a manual review** of the dependency's changelog /
  migration guide before merge — majors are never auto-merged.
- **iOS Swift Package Manager** dependencies are resolved by xcodegen at
  `xcodebuild` time, so Dependabot cannot track them reliably; keep them
  up to date manually.
