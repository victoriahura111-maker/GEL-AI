# Testing

Testing strategy for the AI Virtual Task Assistant monorepo: how the suites are
organised, how to run them, the mocked boundaries, the required-item coverage map,
coverage thresholds, and the guidelines for adding new tests.

The suite is split into two Jest **projects** (server and client) and runs with no
live network and no live database.

---

## 1. Strategy

Three layers, all deterministic and hermetic:

| Layer       | Project  | Tooling                        | What it proves                                                                                                    |
| ----------- | -------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Unit        | `server` | Jest + ts-jest                 | Pure logic: intent parsing, property mapping, reminder schedule math, ranking, validators, redaction, encryption. |
| Integration | `server` | Jest + ts-jest + Supertest     | Routes + controllers + services wired together, over an in-memory PostgREST fake and a routed `fetch` stub.       |
| Client      | `client` | Jest + jsdom + Testing Library | Pages/components render, navigate, call the service layer, and handle loading/empty/error states.                 |

The boundary rule is simple: **the only things mocked are the edges** (AI provider
HTTP, Notion HTTP via `fetch`, Supabase, the browser Supabase client, timers).
Everything between a request and those edges runs for real wherever practical.

### End-to-end assistant flow

`tests/server/assistantFlow.test.ts` is the flagship integration suite. It wires
the **real** assistant controller, intent extractor and task orchestrators to the
Supabase fake and a routed Notion `fetch`, and exercises the full chain:

- message → under-specified → **clarify** (no card, no writes, no Notion call);
- message → complete `create_task` intent → **preview card** with resolved database;
- explicit **confirm** → Notion page + local mirror + pending reminder + audit row;
- ambiguous update intent → **`task_select` card** → confirm the chosen task →
  Notion `PATCH` + mirror update + `task_updated` audit.

---

## 2. How to run

```bash
npm test                      # both projects, no coverage
npm run test:server           # server project only
npm run test:client           # client project only
npm run test:watch            # watch mode
npm run test:coverage         # both projects with coverage + thresholds
npm run test:coverage:server  # server project coverage only
npm run test:coverage:client  # client project coverage only
```

A single file or test name:

```bash
npx jest --selectProjects server tests/server/assistantFlow.test.ts
npx jest -t "ambiguous task update"
```

`npm test` does **not** collect coverage, so it stays fast and the coverage
thresholds are only enforced during a coverage run.

---

## 3. Mocked boundaries

### Server project (`tests/jest.server.config.js`)

- **Supabase** — `@supabase/supabase-js`'s `createClient` is mocked to return the
  in-memory PostgREST fake in `tests/server/supabaseFake.ts`. It implements the
  subset of the query builder the repositories use (`select`/`insert`/`update`/
  `delete`/`upsert`, `eq`/`gte`/`lte`/`lt`/`gt`/`ilike`, `order`/`limit`,
  `single`/`maybeSingle`). Filters are really applied, so a query that forgets to
  scope by `user_id` visibly leaks another user's rows — exactly what the
  isolation suites assert against.
- **AI provider HTTP** — `tests/server/aiProvider.test.ts` exercises the real
  provider module against a mocked global `fetch` (request shape, error mapping,
  no key leakage). Every other suite mocks the provider's `createChatCompletion`.
- **Notion HTTP** — the global `fetch` is replaced with a routed stub (schema
  `GET`, page `POST`/`PATCH`, `/search`, `/databases/:id/query`). The real Notion
  client, schema/property mapping and page helpers run on top of it.
- **Auth** — route suites inject an authenticated user by mocking
  `server/src/middleware/authenticate`; `auth.test.ts` exercises the real
  middleware with a mocked Supabase `auth.getUser`.
- **Environment** — `tests/server/setupEnv.ts` sets dummy Supabase/Notion/
  encryption values so config-dependent code paths are exercised without secrets.
- **Schedulers/timers** — the reminder and follow-up _interval_ loops are never
  started in tests (`start*Scheduler` returns `false` when unconfigured and is only
  called from `src/index.ts`). Tests call the pure tick functions
  (`processDueReminders`, `processFollowUps`) directly with an injected `now`.
  `--detectOpenHandles` reports no leaks.

### Client project (`tests/jest.client.config.js`)

- **jsdom + Testing Library** render real components.
- `tests/client/setup.ts` shims `client/src/services/supabase` (the real module
  reads `import.meta.env`, which CommonJS cannot parse). Suites that need specific
  auth behaviour mock the module themselves, overriding the shim.
- CSS imports map to `tests/client/styleMock.js`.
- Service modules (`assistant`, `tasks`, `reminders`, …) are mocked per suite so
  no network is attempted.

---

## 4. Required-item coverage map

Every item from the product specification, mapped to the suite(s) that cover it.
All items are **covered**.

| #   | Required item             | Primary suite(s) / test(s)                                                                                                                                                                              | Status |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Authentication            | `auth.test.ts`, `routeAuth.test.ts`, client `auth.test.tsx`, `App.test.tsx`                                                                                                                             | ✅     |
| 2   | Authorization             | `routeAuth.test.ts`, `crossUserIsolation.test.ts`, per-route 404 tests                                                                                                                                  | ✅     |
| 3   | Task creation             | `createTask.test.ts`, `assistantActionsRoute.test.ts`, `assistantFlow.test.ts`, `notionPages.test.ts`                                                                                                   | ✅     |
| 4   | Task extraction           | `aiExtraction.test.ts`, `aiFailures.test.ts`, `assistantRoute.test.ts`                                                                                                                                  | ✅     |
| 5   | Missing information       | `assistantRoute.test.ts` (`missing information`), `aiExtraction.test.ts` (clarify)                                                                                                                      | ✅     |
| 6   | Date interpretation       | `aiExtraction.test.ts` (prompt), `timezoneBoundaries.test.ts`, `reminderSchedule.test.ts`                                                                                                               | ✅     |
| 7   | Database selection        | `databaseSelection.test.ts`, `assistantRoute.test.ts` (choice card)                                                                                                                                     | ✅     |
| 8   | Notion OAuth              | `notionOAuth.test.ts`, `oauthState.test.ts`, `encryption.test.ts`                                                                                                                                       | ✅     |
| 9   | Notion database discovery | `notionClient.test.ts`, `notionDatabasesRoute.test.ts`, `notionFailures.test.ts`, client `notionDatabases.test.tsx`                                                                                     | ✅     |
| 10  | Notion schema mapping     | `notionSchema.test.ts`, `propertyMapping.test.ts`, `notionSchemaRoute.test.ts`                                                                                                                          | ✅     |
| 11  | Notion task creation      | `notionPages.test.ts`, `createTask.test.ts`, `assistantFlow.test.ts`, `notionFailures.test.ts`                                                                                                          | ✅     |
| 12  | Task updates              | `updateTask.test.ts`, `assistantActionsRoute.test.ts`, `assistantFlow.test.ts`, client `taskUpdate.test.tsx`                                                                                            | ✅     |
| 13  | Task completion           | `updateTask.test.ts` (payload + mirror + `task_completed` audit), `assistantActionsRoute.test.ts`, client `taskUpdate.test.tsx`                                                                         | ✅     |
| 14  | Task cancellation         | `updateTask.test.ts` (payload + mirror + `task_cancelled` audit), `assistantActionsRoute.test.ts`                                                                                                       | ✅     |
| 15  | Reminder scheduling       | `reminderSchedule.test.ts`, `timezoneBoundaries.test.ts`, `remindersRoute.test.ts`                                                                                                                      | ✅     |
| 16  | Reminder delivery         | `reminderEngine.test.ts` (claim→dispatch→sent→audit, failure, idempotency, recurrence), `inAppChannel.test.ts`, `notificationService.test.ts`                                                           | ✅     |
| 17  | Follow-up                 | `followUpCandidates.test.ts`, `followUpEngine.test.ts`, `followUpRespond.test.ts`, `assistantActionsRoute.test.ts`, client `followUp.test.tsx`                                                          | ✅     |
| 18  | Overdue tasks             | `taskQuery.test.ts` (overdue bucket + awaiting window), `followUpCandidates.test.ts`, client `dashboard.test.tsx`                                                                                       | ✅     |
| 19  | Multiple matching tasks   | `resolveTask.test.ts` (ambiguous), `assistantRoute.test.ts` (`task_select`), `assistantFlow.test.ts` (E2E), client `taskUpdate.test.tsx`                                                                | ✅     |
| 20  | Cross-user access         | `crossUserIsolation.test.ts`, `taskRepository.test.ts`, `notificationRepository.test.ts`, `conversationPersistence.test.ts`, `resolveTask.test.ts`                                                      | ✅     |
| 21  | Prompt injection          | `promptInjection.test.ts`, `untrustedContent.test.ts`                                                                                                                                                   | ✅     |
| 22  | AI failures               | `aiProvider.test.ts`, `aiFailures.test.ts`, `assistantRoute.test.ts`                                                                                                                                    | ✅     |
| 23  | Notion failures           | `notionFailures.test.ts`, `notionClient.test.ts`, `notionSchema.test.ts`, `notionPages.test.ts`, `notionDatabasesRoute.test.ts`, `syncEngine.test.ts`, `assistantActionsRoute.test.ts` (status mapping) | ✅     |
| 24  | Synchronization           | `syncEngine.test.ts`, `syncRoute.test.ts`, client `sync.test.tsx`                                                                                                                                       | ✅     |
| 25  | Timezone handling         | `taskQuery.test.ts`, `reminderSchedule.test.ts`, `timezoneBoundaries.test.ts`, `followUpRespond.test.ts`                                                                                                | ✅     |

### Phase 18 additions (gaps closed)

| Suite                                        | Added               | Purpose                                                                                                                                                                                    |
| -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assistantFlow.test.ts` _(new)_              | 2 integration tests | End-to-end message → clarify → preview → confirm (mirror + reminder + audit); ambiguous update → selection card → confirm.                                                                 |
| `aiFailures.test.ts` _(new)_                 | 6 tests             | Provider HTTP/network failure, unparseable + schema-invalid output (after the single retry), not-configured, and a no-stack/no-raw-output guarantee.                                       |
| `notionFailures.test.ts` _(new)_             | 19 tests            | Failure matrix (401/403/404/429/5xx, unreadable body, dead transport) for every Notion operation; token never leaks.                                                                       |
| `timezoneBoundaries.test.ts` _(new)_         | 5 tests             | Prompt carries now + timezone; same wall clock → different UTC across `Africa/Lagos`/`UTC`/`America/New_York`; `before`/`at` scheduling per zone; day bucketing in a negative-offset zone. |
| `assistantRoute.test.ts` _(extended)_        | 2 tests             | Missing-information: multiple missing fields → question, no card, no DB lookup, no task resolution.                                                                                        |
| `assistantActionsRoute.test.ts` _(extended)_ | 7 tests             | Notion error → HTTP status mapping (`not_connected`/`forbidden`/`not_found`/`rate_limited`/`network_error`/`invalid_response`/`api_error`).                                                |

---

## 5. Coverage

Coverage is configured in the **root** `jest.config.js` (`coverageReporters` and
`coverageThreshold`) plus `tests/jest.server.config.js` /
`tests/jest.client.config.js` (`collectCoverageFrom`,
`coveragePathIgnorePatterns`).

- **Scope** — `server/src/**` and `client/src/**`, excluding bootstrap
  entrypoints (`server/src/index.ts`, `client/src/main.tsx`), ambient types
  (`server/src/types`, `client/src/vite-env.d.ts`, client `types`), pure barrels
  (`**/index.ts` re-export-only files), `client/src/services/supabase.ts`
  (reads `import.meta`, unsupported by the CommonJS test transform) and the thin
  `client/src/utils/navigation.ts` DOM wrapper (asserted at its call site).
- **Reporters** — `text-summary` (console) and `lcov`
  (`coverage/lcov-report/index.html`, `coverage/lcov.info`).
- `coverageReporters` **and** `coverageThreshold` live in the **root**
  `jest.config.js`: Jest 30 treats both as global-only options (declaring them in
  a project config emits a validation warning and the value is ignored). The
  threshold is therefore evaluated against the **merged** client+server coverage
  rather than per project.

### Achieved vs. threshold

Measured on the current suite; the threshold sits ~2 points below the merged
figure to catch real regressions without being brittle.

| Scope              | Statements | Branches   | Functions  | Lines      |
| ------------------ | ---------- | ---------- | ---------- | ---------- |
| Merged — achieved  | **78.15%** | **64.15%** | **66.21%** | **80.18%** |
| Merged — threshold | 76         | 62         | 64         | 78         |

The suite currently runs **64 suites / 564 tests** (51 server suites / 513 tests,
13 client suites / 51 tests). `npm run test:coverage` prints this merged summary
after both projects run.

### Reading the report

- Console: the `text-summary` block after a coverage run.
- HTML: open `coverage/lcov-report/index.html` for per-file line/branch detail.
- Machine-readable: `coverage/lcov.info`.

A threshold miss fails the coverage run (non-zero exit) with the exact
metric/folder in the output; fix by adding tests — do **not** lower the threshold
to hide a regression.

---

## 6. Guidelines for adding tests

1. **Mock only the edges.** Prefer the Supabase fake + `fetch` stub over mocking a
   service you are trying to test. Mock the AI provider and the browser Supabase
   client.
2. **Be deterministic.** Never rely on the real clock. Pass an explicit `now` to
   scheduling/query helpers, or construct fixed ISO strings. Avoid `Date.now()` in
   assertions.
3. **No network, no DB.** If a test needs either, it is using the wrong boundary.
4. **Scope to the user.** For any repository/route change, assert that another
   user's data is unreachable (see `crossUserIsolation.test.ts`).
5. **Prefer extending an existing suite** when the concern belongs to it; add a
   new suite only when it improves clarity (e.g. a cross-cutting matrix such as
   `notionFailures.test.ts`).
6. **Assert safety, not just success.** For any error path, assert the user-facing
   message is generic and never contains tokens, raw provider payloads or stack
   traces.
7. **Cover the listed requirement items.** When adding a feature, extend the
   required-item coverage map in §4 and keep the suite green.
8. **Run before pushing:**
   ```bash
   npm test && npm run test:coverage && npm run build && npm run lint
   ```
   Use `npx jest --selectProjects server --detectOpenHandles` if a suite might
   leave a handle open.
9. **Add to the escape hatches sparingly.** If you must exclude a file from
   coverage, add it to `coveragePathIgnorePatterns` with a one-line reason.
