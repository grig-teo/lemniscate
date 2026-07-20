# Coding standards

These standards apply to all TypeScript in the project (backend, worker, frontend).
Follow them when writing or modifying code; see the **Refactoring Protocol** at
the bottom for how to apply them to existing code.

# Coding Standards: Functions, Classes, and Control Structures

## 1. Functions & Methods

* **Line Limit:** Keep functions under 20 lines of executable code.
* **Max Limit:** Never exceed 50 lines (one screenful). If a function requires
  scrolling, refactor it.
* **Single Responsibility:** A function must do exactly one thing. If its
  purpose requires the word "AND", split it.
* **Nesting Depth:** Maximum 2 levels of nesting (loops, conditionals) per
  function.

## 2. Classes & Modules

* **Line Limit:** Keep classes between 100 to 200 lines of code.
* **Max Limit:** Absolute maximum of 300 lines. Prevent "God Objects".
  The same spirit applies to modules: split files that grow past ~300 lines
  into focused modules.
* **Cohesion:** Every method within a class should ideally utilize or mutate
  the class attributes. If a method does not touch class state, make it a
  utility function or move it.

## 3. Conditionals (if-else)

* **Guard Clauses First:** Always validate inputs and handle edge cases/errors
  at the top of the function using early returns (`return`, `break`,
  `continue`).
* **No Happy-Path Else:** Do not wrap the main logic inside an `else` block.
  Eliminate the `else` keyword by using early returns.
* **Extraction:** If the body of an `if` or `else` statement exceeds 3 lines,
  extract that logic into its own descriptively named function.

## 4. Switch / Match Constructions

* **Single Location:** A `switch` or pattern matching block on a specific type
  should exist in only one place in the codebase (e.g., inside a Factory or
  Mapper).
* **Polymorphism over Switch:** If a `switch` statement grows beyond 5 cases or
  is repeated across multiple files, refactor the codebase to use Polymorphism
  (interfaces/derived classes) instead.
* **No Business Logic:** Do not write complex logic inside `case` blocks. Call
  a dedicated function instead.

## 5. Refactoring Protocol for the Agent

* **Pre-computation:** Before generating code, analyze if the proposed function
  or class will exceed the limits above.
* **Auto-Split:** If a requested feature pushes a function past 20 lines,
  automatically design the helper functions and present the refactored modular
  architecture first.

## 6. Single source of truth (no duplicate logic)

Every piece of logic — a mapping, a parser, a validation rule, a query
filter — should have exactly one home in the codebase. When the same rule
lives in two files, one of them silently goes stale.

* **Find before you write.** Before implementing anything non-trivial, check
  the graph/grep for an existing version and reuse it. "It's just a few lines"
  is not a reason to copy — a few duplicated lines are exactly where two
  implementations diverge over time.
* **One parameterized function beats N copies.** Near-identical helpers
  (differing only by field name, constant, or column) must be unified by
  parameterization, not copy-pasted. If two functions differ only in a value,
  they are one function.
* **Extract-and-delete, not extract-and-leave.** When you pull shared logic
  out into a helper, the duplicated originals are removed in the same task —
  a dangling copy is the bug this rule exists to prevent. Half a refactor
  (extracted helper + the old copy still present) is worse than no refactor,
  because now there are three places the logic can rot.

## 7. Test-driven (write the test first)

For any unit of behavior — a parser, mapper, query, validation rule, repository
method, or pure helper — the test is written BEFORE the implementation, not
after. The Red → Green → Refactor loop is the default, not an option:

1. **Red.** Write a failing test that pins the behavior the next change must
   produce. Run it (`cd backend && npm test`) and watch it
   fail for the right reason (wrong result / no symbol yet).
2. **Green.** Write the minimum code that makes it pass. No more.
3. **Refactor.** Improve the code with the test as the safety net; re-run after
   every step.

A task is not "done" because the code looks right — it's done because the test
that was red is now green, alongside the whole suite. Refactors specifically
(per section 6) MUST land a locking test against the current code before any
production line is deleted or rewritten.

---

## Project layout

```
docker-compose.yml    # postgres, redis, backend, worker, frontend
backend/              # Fastify API + BullMQ worker (npm run build / npm test)
frontend/             # Vite/React app (npm run build = tsc --noEmit && vite build)
scripts/              # install-linux.sh / install-macos.sh one-command deploy
landing/              # static landing page
docs/                 # design specs
```

## Verification commands

- Backend: `cd backend && npm run build && npm test` (tsc strict, vitest)
- Frontend: `cd frontend && npm run build` (tsc --noEmit + vite build)
- Full stack: `docker compose up --build` → `/health` on :3000, SPA on :8080
