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
