# Shared API-contract fixtures

This directory holds canonical JSON snapshots that pin wire formats consumed
by multiple implementations. Changing a fixture without updating every
consumer fails CI.

## Mobile API responses (`*.json`)

Snapshots of backend response shapes consumed by the native apps. They are
decoded by contract tests on both platforms:

- Android: `android/app/src/test/.../core/api/ContractFixturesTest.kt`
- iOS: `ios/LemniscateTests/ContractFixturesTests.swift`

The field set is the intersection of what the mobile DTOs declare
(`android/.../core/api/Models.kt`, `ios/Lemniscate/Core/API/Models.swift`)
and what the backend serializes (Prisma `Task`/`Repository` models +
`backend/src/routes/`). Enum-ish values (`kind`: `prompt`/`proposal`,
`status`: `pending`/`queued`/`running`/`awaiting_review`/`done`/`failed`/
`closed`) come from `backend/prisma/schema.prisma`.

If the backend renames a field or changes a payload shape that the apps
depend on, update these fixtures in the same PR — the mobile CI jobs will
fail until the apps' DTOs match again. To sanity-check that the tests are
actually wired up, rename one field in a fixture and watch both platforms
go red, then revert.

## Device WebSocket protocol (`device-ws/`)

Canonical frames for the device WS tunnel (`GET /api/devices/ws?token=...`),
decoded by three consumers: the backend, the Node CLI agent, and the Tauri
agent. See `device-ws/README.md` for the full layout and instructions on
adding a new command type.

