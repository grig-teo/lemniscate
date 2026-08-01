# Gitlem Frontend UI — Implementation Plan

## Context
The gitlem **backend** is fully implemented, tested, merged, and deployed (PR #100). The **entire gitlem frontend UI is missing** — `grep -rli gitlem frontend/src` returns nothing, so the feature is unreachable from the app. This plan builds the full gitlem frontend surface against the existing backend endpoints. No backend work needed.

Two decisions (confirmed):
- **Layout**: gitlem grid + details render as **in-pane views** (selection-context state + `ConsolePane` early-return), mirroring `ArchivedPane`/`PrListPane`/`ServiceDetail`.
- **Repos source**: **filter `useRepositories()`** by the gitlem connection (gitlem repos already sync into `GET /api/repositories`). No new backend endpoint.

A new branch `lemniscate/gitlem-frontend-ui` + PR per AGENTS.md §8. TDD throughout (AGENTS.md §7).

---

## Phase 1 — Provider registration + types (foundation, ~4 files)

**1.1** `frontend/src/lib/api-types.ts:28` — widen `GitProvider` union to add `'gitlem'`.

**1.2** `frontend/src/lib/providers.tsx` — add `gitlem: 'Gitlem'` to `PROVIDER_BRAND_LABELS` (:20) and a `gitlem` branch in `ProviderIcon` (:44). Reuse a lucide icon (e.g. `Server` or `GitFork`) as the glyph for now (the spec's SVG brand mark can be swapped later).

**1.3** `frontend/src/components/icons/GitlemIcon.tsx` (new) — a small SVG icon component matching `GitVerseIcon.tsx`'s one-component structure, so provider buttons/labels render with a distinct mark. Used by `ProviderIcon`.

*Test*: add `frontend/src/lib/providers.test.tsx` asserting `providerLabel('gitlem')` → `'Gitlem'` and `ProviderIcon` renders without error for `'gitlem'`.

---

## Phase 2 — Gitlem auth page (login/register, ~4 files)

**2.1** `frontend/src/App.tsx` — add public route `{ path: '/connect/gitlem', element: <GitlemConnectPage /> }` to the `createBrowserRouter` array (mirrors `/login`). Public — not wrapped in `RequireAuth`.

**2.2** `frontend/src/components/ConnectProviderButtons.tsx` — add `onGitlem: () => void` prop and a 5th `<Button variant="outline">` (mirrors the existing GitVerse button at :36-39) labeled "Connect Gitlem" with `<ProviderIcon provider="gitlem" />`.

**2.3** `frontend/src/pages/LoginPage.tsx` — thread `onGitlem={() => navigate('/connect/gitlem')}` into `ConnectProviderButtons` (mirrors the `onGitverse` plumbing).

**2.4** `frontend/src/pages/GitlemConnectPage.tsx` (new, ~150 lines, split into sub-components to stay <20 lines/func per AGENTS §1):
- Uses `useMe()` for spinner + self-redirect to `/dashboard` when logged in (mirrors `LoginPage`).
- **Login form**: email + password → `api.post('/api/gitlem/login', { email, password })`.
- **Register flow** (tab/toggle): email → `POST /api/gitlem/register/code` → enter 6-digit code → `POST /api/gitlem/register` (password optional; backend generates+emails if omitted).
- On success: `queryClient.invalidateQueries({ queryKey: ['me'] })` then `navigate('/dashboard')` (CRITICAL — the session cookie is set by the POST but the SPA cache is stale; without invalidation `RequireAuth` bounces back to login).
- Inline error rendering from `ApiError.message` (mirrors `GitVerseConnectDialog`).
- Add a back-to-login link.

**2.5** `frontend/src/lib/queries/gitlem-auth.ts` (new) — three mutations: `useGitlemLogin`, `useGitlemRequestCode`, `useGitlemRegister`. `meta: SUPPRESS_ERROR_TOAST_META` (errors shown inline). Re-export from `hooks.ts`.

*Tests*: `frontend/src/pages/GitlemConnectPage.test.tsx` — mock `api.post`, assert (a) login posts correct body + invalidates `['me']` + navigates on success, (b) register code-then-register two-step flow, (c) 401 shows inline error. Mock `useMe` to return `null` (not logged in).

---

## Phase 3 — Top-nav gitlem button + selection state (~3 files)

**3.1** `frontend/src/lib/selection.tsx` — extend `WorkspaceSelectionValue` with:
```ts
gitlemViewRepoName: string | null;     // null = grid view; a name = detail view
openGitlemView: () => void;            // grid
openGitlemRepo: (name: string) => void;// detail
closeGitlemView: () => void;           // back to console
```
Add state + callbacks (mirroring `openArchived`/`closeArchived`). `openGitlemView`/`openGitlemRepo` clear the other pane selections (task/archived/service) like the existing openers do.

**3.2** `frontend/src/components/TopNav.tsx` — add a gitlem icon-button on the LEFT (next to the brand `<Link>`). Render it **only when a gitlem connection exists** (read `useConnections()`, find `provider === 'gitlem'`). `onClick` → `openGitlemView()`. `Button variant="ghost" size="icon"` + `<GitlemIcon className="h-5 w-5" />` + `Tooltip` (mirrors `ThemeToggle`).

**3.3** `frontend/src/components/ConsolePane.tsx:137` — add two early-return branches before the existing ones:
```tsx
if (gitlemViewRepoName) return <GitlemRepoDetail name={gitlemViewRepoName} />;
if (gitlemViewOpen) return <GitlemReposGrid />;
```
(`gitlemViewOpen` derived as `gitlemViewRepoName !== null || gitlemViewActive` — keep a separate boolean for "grid open" so detail can stack over grid.)

*Tests*: `TopNav` renders gitlem button only when a gitlem connection is present; clicking calls `openGitlemView`. `ConsolePane` shows grid vs detail vs console based on selection state.

---

## Phase 4 — Gitlem repos grid + "+" card + auto-provision (~4 files)

**4.1** `frontend/src/lib/queries/gitlem.ts` (new) — query hooks against the backend:
- `useGitlemRepos()` — **filters `useRepositories()`** by the gitlem connection: `repositories.filter(r => r.connection.provider === 'gitlem')`.
- `useGitlemRepoDetail(name)` — `GET /api/gitlem/repos/:name` → `{ repository: {...} }`.
- `useGitlemReadme(name, branch)` — `GET /api/gitlem/repos/:name/readme/:branch`.
- `useGitlemBranches(name)` — `GET /api/gitlem/repos/:name/branches`.
- `useGitlemPrs(name)` — `GET /api/gitlem/repos/:name/prs`.
- `useGitlemCiRuns(name)` — `GET /api/gitlem/repos/:name/ci-runs`.
- Mutations: `useEnsureGitlemAccount()` (`POST /api/gitlem/ensure`), `useCreateGitlemBranch(name)`, `useTriggerGitlemCi(name)`. Re-export from `hooks.ts`.

**4.2** `frontend/src/components/gitlem/GitlemReposGrid.tsx` (new) — a right-pane view modeled on `ArchivedPane.tsx` (header bar with title + close `X` → `closeGitlemView()`). Body is a responsive card grid: `grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3` (pattern from `LibraryAttachments.tsx:106`).
- Each repo = a clickable card (`<button>`) → `openGitlemRepo(name)`.
- **"+" card** at the end of the grid → calls `onCreate()` (opens `CreateRepoDialog` preset to gitlem).
- Empty state: a centered "+ Create your first gitlem repo" card.

**4.3** Auto-provision gating (in `GitlemReposGrid` or a small hook `useEnsureGitlemBeforeCreate`):
- On "+" click: check `useConnections()` for a gitlem connection. If **none**, call `useEnsureGitlemAccount().mutate()` (which `POST /api/gitlem/ensure` — backend checks first, only creates if absent, emails credentials, posts notification). On success (`created: true`/`false`), invalidate `['connections']`+`['repositories']`, THEN open `CreateRepoDialog` preset to gitlem. If `ensure` fails (e.g. 400 no email channel), show the inline error.
- This satisfies: "create account only if not present, check first" (backend's `ensureAccountHandler` returns `created:false` if exists) + "email credentials + notify" (backend does both in `ensureGitlemAccountForUser`).

**4.4** `frontend/src/components/repo-tree/CreateRepoDialog.tsx` — add a `presetConnectionId?: string` (or `presetProvider?: 'gitlem'`) prop. In `useCreateRepoForm`, seed `connectionId` from it and filter `ConnectionSelect` to that connection (hide the selector when preset). The grid passes the gitlem connection id.

*Tests*: grid renders cards from filtered repos; "+" with no gitlem connection calls `ensure` then opens dialog; "+" with existing connection opens dialog directly; clicking a card calls `openGitlemRepo`.

---

## Phase 5 — Gitlem repo detail view (~5 files, each focused)

`frontend/src/components/gitlem/GitlemRepoDetail.tsx` (new) — right-pane view (header: repo fullName + close → `closeGitlemView` to return to grid). Fetches `useGitlemRepoDetail(name)`. Tabs/sections:

**5.1 README tab** — `useGitlemReadme(name, branch)`. Render markdown content in a **vertically scrollable** container (`overflow-y-auto`, `ScrollArea` from `ui/scroll-area.tsx`). 404 → "No README on this branch" placeholder.

**5.2 Branch switcher** — a `<Select>` (radix, `ui/select.tsx`) populated from `repository.branches`, value = selected branch; switching re-fetches README + CI for that branch. "New branch" action → `useCreateGitlemBranch` (small dialog: name + from).

**5.3 Clone** — shows `repository.cloneUrl` in a read-only input + a copy button (`Copy` lucide icon + `navigator.clipboard.writeText`). Brief instructions: `git clone <cloneUrl>` (auth = the gitlem account's emailed PAT over HTTP Basic).

**5.4 CI/CD** — `useGitlemCiRuns(name)` list (latest run status badge + log preview). "Run CI" button on the current branch → `useTriggerGitlemCi(name).mutate({ branch })`, refetch runs on success.

**5.5 Open PRs** — `useGitlemPrs(name)` list (number, title, head→base, state badge). Empty → "No open pull requests".

Split each tab into its own small component (`GitlemReadmeTab`, `GitlemBranchesTab`, `GitlemCiTab`, `GitlemPrsTab`) under `frontend/src/components/gitlem/` to keep files <300 lines (AGENTS §2) and functions <20 lines (§1).

*Tests*: detail renders README (scrollable), branch switch refetches README, clone copies URL, CI run button triggers + refetches, PRs list shows open PRs. Mock `api.get/post` per backend contract.

---

## Phase 6 — Wiring + landing + polish

**6.1** Sidebar "+": existing `RepoTree` "+" already opens `CreateRepoDialog` (no change needed for the generic path). Optionally add a gitlem quick-create affordance.

**6.2** Run frontend `check:max-lines` to confirm no file >300 lines; refactor if any component grows past it (the detail view is the likely candidate — split tabs aggressively).

**6.3** Verify `npm run build` (tsc --noEmit + vite) and `npm test` are green. Run `VITE_API_URL="" npm test` to mirror CI (the `.env` local artifact otherwise breaks 62 tests).

---

## Out of scope (explicit)
- No backend changes (all endpoints exist and are tested).
- The custom SVG brand mark from the spec (`grok-8258bdf3…svg`) — I'll use a lucide icon placeholder (`Server`/`GitFork`) so the UI works end-to-end; the SVG can be dropped into `GitlemIcon.tsx` later as a pure asset swap.
- Markdown rendering library: README shown as preformatted/scrollable text unless a markdown renderer is already a dependency (check `package.json`); if `react-markdown` isn't present, render as `<pre>` with `whitespace-pre-wrap` to avoid adding a dependency.

## Files touched (summary)
- Edit: `api-types.ts`, `providers.tsx`, `App.tsx`, `ConnectProviderButtons.tsx`, `LoginPage.tsx`, `selection.tsx`, `TopNav.tsx`, `ConsolePane.tsx`, `CreateRepoDialog.tsx`, `hooks.ts`
- New: `icons/GitlemIcon.tsx`, `pages/GitlemConnectPage.tsx`, `lib/queries/gitlem-auth.ts`, `lib/queries/gitlem.ts`, `components/gitlem/GitlemReposGrid.tsx`, `components/gitlem/GitlemRepoDetail.tsx` (+ tab subcomponents), and matching `.test.tsx` files.

## Verification
- `cd frontend && VITE_API_URL="" npm run build && npm test` green.
- Manual: login page shows "Connect Gitlem" → register/login flow → dashboard; top-nav gitlem icon appears when connected → grid → "+" auto-provisions → create repo → detail view with README/clone/CI/PRs/branches.