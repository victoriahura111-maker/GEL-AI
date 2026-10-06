# Architecture

Describes the high-level system architecture, module boundaries, and how the client, server, database, AI, and Notion components fit together.

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ Client (React 18 + Vite + Tailwind)                                    │
│  AssistantPage → ChatContext → services/assistant.ts → services/api.ts │
│  ChatMessages → MessageBubble → CardRenderer → {Task,Reminder,          │
│    TaskUpdate,TaskSelect,Confirmation,FollowUp}Card                     │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ Bearer token (Supabase session)
┌───────────────────────────────▼──────────────────────────────────────┐
│ API server (Express 4 + Zod)                                           │
│  routes/assistant.ts → controllers/{assistant,assistantActions}        │
│  middleware/authenticate → req.user.id (the ONLY source of user scope) │
└───────┬──────────────────────────────────┬───────────────────────────┘
        │                                  │
┌───────▼───────────────┐        ┌─────────▼──────────────────────────┐
│ AI services            │        │ Notion + task services             │
│ ai/{provider,extractor,│        │ notion/{client,schema,pages,       │
│ prompts,toCards}       │        │   databaseSelection,databaseMapping│
│ validators/intent      │        │ tasks/createTask + repositories    │
└───────┬───────────────┘        └─────────┬──────────────────────────┘
        │                                  │
┌───────▼──────────────────────────────────▼───────────────────────────┐
│ Repositories → Supabase Postgres (RLS; service-role client)            │
│  assistant_tasks · assistant_reminders · assistant_audit_logs          │
│  assistant_conversations · assistant_messages(cards jsonb)             │
│  notion_connections(token encrypted) · notion_database_mappings        │
└──────────────────────────────────────────────────────────────────────┘
```

## Request paths

- **Chat turn** — `POST /api/assistant/messages` → validate → resolve/create
  conversation → `extractIntent()` → `intentToCards()` → (Phase 10) enrich the
  `task` card with the resolved database, or emit a `confirmation` card listing
  candidates → persist both messages → `{ message, conversationId }`.
- **Confirm action** — `POST /api/assistant/actions` → validate the discriminated
  union → `createTask()` → `{ message, conversationId, task, notionUrl }` (or
  `needsDatabase` + `candidates`) → persist the assistant message with a card
  carrying `notionUrl`.

## Phase 10 — task creation flow

```
confirm card ──▶ assistantActionsController ──▶ createTask(userId, input)
   (1) Zod-validate input
   (2) resolve DB: explicitId? (schema fetch, user token) : selectDatabase(category)
         └─ needs_choice ─▶ { status:'needs_database', candidates }   [no Notion call]
         └─ none        ─▶ { status:'no_databases',  candidates:[] }   [no Notion call]
   (3) getDatabaseSchema ─▶ resolvePropertyMapping ─▶ buildNotionProperties
   (4) createNotionPage (POST /pages)                     ┐
   (5) insert assistant_tasks mirror (synced)             │ side-effects
   (6) insert assistant_reminders (pending) — if provided │
   (7) insert assistant_audit_logs (task_created)         ┘
   (8) ─▶ { status:'created', task, notion:{id,url}, database, reminder? }
```

## Module boundaries & invariants

- **User scope is server-owned.** `userId` always comes from `req.user.id` (the
  verified Bearer token), never from a request body, and every repository query is
  additionally filtered by `user_id` (defense-in-depth over RLS).
- **Secrets stay server-side.** The Notion access token is decrypted only inside
  the Notion client; it is never logged, returned, or embedded in an error. Raw
  Notion payloads never leave the server (clients get normalised `{ id, title,
url }` shapes).
- **Pure core, thin edges.** `databaseSelection`, `propertyMapping`, and
  `toCards` are pure and unit-tested; controllers stay thin and delegate to
  services.
- **Graceful degradation.** Missing Supabase degrades reads to `[]`/`null` and
  skips persistence rather than crashing; AI/Notion failures map to typed, safe
  errors.
- **Fail-safe creation.** If Notion fails, nothing is mirrored locally. If the
  page is created but the local mirror write fails, the Notion URL is still
  returned; reminder/audit writes are best-effort and never fail the request.
- **Confirm-only.** The assistant never auto-creates or mutates a task; every
  write happens exclusively via the explicit `POST /api/assistant/actions`
  confirmation.

See [assistant.md](assistant.md) for the action contract and [notion-integration.md](notion-integration.md)
for the Notion page-write + selection details.

## Phase 11 — task update flow

```
chat message (update/complete/cancel/delete/postpone/reschedule)
   │
   ▼  assistantController
resolveTask(userId, identifier) ──▶ found ─────▶ task_update card (taskId, changes, action)
                                 ├─ ambiguous ─▶ task_select card (candidates + action/changes)
                                 └─ not_found ─▶ conversational clarification (no card)

confirm card ──▶ assistantActionsController ──▶ applyTaskUpdate / deleteTask
   (in-place) Zod-validate ▶ getTaskById ▶ schema ▶ resolvePropertyMapping
              ▶ buildNotionProperties(changed only) ▶ updatePage ▶ update mirror ▶ audit
   (move)     createNotionPage(target) ▶ archivePage(original) ▶ update mirror ▶ audit
   (delete)   archivePage ▶ cancel pending reminders ▶ delete mirror row ▶ audit
```

Resolution/disambiguation, the update/move/delete sequences, the extended action
contract, and the failure policies are documented in [assistant.md](assistant.md);
the page update/archive + move policy is documented in
[notion-integration.md](notion-integration.md).

### Partial-failure policy

- Notion failure ⇒ the typed error propagates and the mirror is **unchanged**.
- Notion success + mirror-write failure ⇒ the Notion result (URL) is still
  returned with a warning; the change is never silently lost.
- Move + archive failure ⇒ **both pages are kept**, the mirror points at the new
  page, and a warning explains it.
- Missing Notion status option ⇒ status updated locally only, with a warning.

## Phase 12 — task dashboard query flow

The dashboard reads the local `assistant_tasks` mirror through a dedicated,
read-only query service ([`services/tasks/query.ts`](../server/src/services/tasks/query.ts:1)).

```
GET /api/tasks/summary ─▶ tasksController ─▶ loadUserTimezone(user_profiles)
                                          └▶ getTaskSummary(userId, tz)
GET /api/tasks/grouped ─▶ tasksController ─▶ getTasksGrouped(userId, tz)
GET /api/tasks         ─▶ tasksController ─▶ listTasksForUser(userId, filters)
GET /api/tasks/:id     ─▶ tasksController ─▶ getTaskById(userId, id) ─▶ 404 if absent/foreign
                                   │
                                   └─ (grouped/list/id) attachDatabaseNames:
                                      join notion_database_mappings → notion_database_name
```

### Timezone handling

`due_date`/`due_time` are **wall-clock** values in the user's timezone. Buckets
are therefore computed by comparing those fields against the user's _current
local_ wall clock — never server-local/UTC `new Date()` values:

1. The controller reads `user_profiles.timezone` (best-effort; fallback `UTC`).
2. The query service derives the local date/time with
   `Intl.DateTimeFormat({ timeZone })` (built into Node — no date library) and
   advances the instant by 48h for the "awaiting update" cutoff.
3. Each task is classified against that clock:
   - **today** — open, not `overdue`-status, due on the local date.
   - **upcoming** — open, not `overdue`-status, due after the local date.
   - **overdue** — open and past due (before today, or today with the due time
     already reached), **or** `status === 'overdue'` regardless of date.
   - **inProgress** — `status === 'in_progress'`.
   - **awaitingUpdate** — open and either flagged `awaiting_follow_up` by the
     Phase 15 follow-up engine, **or** (overdue / due within the next 48h) as the
     fallback derivation.
   - **completed** — `status === 'completed'`.
     `cancelled` tasks are excluded from every open bucket, like `completed`.
     `today`/`upcoming`/`overdue` can overlap (a task due today whose time has
     passed is both "today" and "overdue").
4. `GET /api/tasks/summary` returns `{ counts, generatedAt, timezone }`;
   `GET /api/tasks/grouped` returns `{ buckets, generatedAt, timezone }` with each
   bucket bounded to 20 tasks.

### Degradation & errors

- Supabase-unconfigured: the pure query functions return zeroed/empty buckets
  (the repository degrades to `[]`); the HTTP layer additionally answers `503`.
- `400` invalid list filters (Zod), `404` missing/foreign task, `503` unconfigured.
- All queries are `user_id`-scoped; Notion tokens and raw payloads never surface.
  The client never calls Notion directly — it renders `notion_url` (a public link).

## Phase 15 — follow-up engine & scheduler

The follow-up engine mirrors the Phase 13 reminder worker: a pure, throw-free
tick core plus an interval scheduler.

```
src/index.ts (bootstrap only)
   └─ startFollowUpScheduler()        ── no-op unless Supabase configured + FOLLOW_UP_ENABLED
        └─ setInterval(FOLLOW_UP_TICK_MS, unref) ── overlap guard (skip if in flight)
              └─ processFollowUps(now, cap)         [never throws]
                   (1) selectFollowUpCandidates(nowIso)   — open tasks, anti-spam filtered
                   (2) for each candidate (isolated, capped):
                        dispatchNotification(msg + follow_up card, { channels:['in_app'] })
                        └─ in_app: persist unread row AND append proactive assistant message
                                  carrying the card
                        updateFollowUpFields(user, task, { last_follow_up_at, follow_up_count+1,
                                                            awaiting_follow_up:true })
                        audit 'follow_up_sent'
```

- **Lifecycle.** `startFollowUpScheduler`/`stopFollowUpScheduler` live in
  [`services/followup/scheduler.ts`](../server/src/services/followup/scheduler.ts:1).
  The scheduler is armed **only** by `src/index.ts`, stopped on `SIGTERM`/`SIGINT`,
  and is inert in tests (no timer is created).
- **Response path.** A card button POSTs to `POST /api/assistant/actions`
  (`follow_up_response` / `follow_up_reason` / `follow_up_new_deadline`) →
  `handleFollowUpResponse` → `applyTaskUpdate` + clear `awaiting_follow_up` +
  audit. See [assistant.md](assistant.md#phase-15--follow-up-engine).
- **Isolation.** A dispatch/state-write failure on one candidate is recorded
  (`follow_up_failed` audit) and never aborts the tick; selection failure yields
  an empty result.
- **No secrets.** Cards and audit metadata carry only task ids/titles/deadline
  context — never tokens or raw Notion payloads.

## Phase 16 — synchronization engine & scheduler

The sync engine reconciles the local `assistant_tasks` mirror with Notion in both
directions. It is a pure, throw-free core plus an opt-in interval scheduler.

```
POST /api/sync ─▶ syncController ─▶ (configured? connected? cooldown?) ─▶ syncUser(userId, { direction })
GET  /api/sync/status ─▶ syncController ─▶ getSyncStatus (watermark + counts + recent errors)

syncUser(userId, { direction:'both'|'pull'|'push', now })
  ├─ state = getSyncState(userId)                     watermark = last_synced_at ?? epoch
  ├─ PULL  (listMappings → getDatabaseSchema → resolvePropertyMapping → queryDatabasePages)
  │     per page: reverse-map (mapNotionPageToTask) →
  │        missing        → create mirror (source_of_change:'notion', sync_status:'synced')
  │        exists         → last-write-wins vs local updated_at (Notion newer ⇒ apply)
  │        archived/trash → status:'cancelled', sync_status:'error'
  └─ PUSH  (listTasksForSync → filter source_of_change != 'notion' && updated_at > last_synced_at)
        buildNotionProperties → updatePage → sync_status:'synced' | 'error' (continue)

src/index.ts (bootstrap only)
   └─ startSyncScheduler()   ── no-op unless Supabase + Notion configured and SYNC_ENABLED=true
        └─ setInterval(SYNC_TICK_MS, unref) ── overlap guard
              └─ listConnectedUserIds() → per user (cooldown-guarded): syncUser('both')  [never throws]
```

- **Conflict policy.** Last-write-wins by comparing Notion `last_edited_time` to
  the local `updated_at`: a newer local change is never overwritten by a stale
  Notion value (and vice versa). Local-newer rows are left for the push phase.
- **Watermark.** `user_sync_state.last_synced_at` (the last clean pull) drives the
  `last_edited_time after` query filter; it advances only when the pull pass has no
  errors, so failed items are retried next run.
- **Loop prevention.** A pulled row is stamped `source_of_change:'notion'` (the
  push filter skips it); a pushed row is stamped `last_synced_at:now`, and the pull
  ignores pages with `last_edited_time ≤ last_synced_at` (plus the query watermark).
- **Lifecycle.** `startSyncScheduler`/`stopSyncScheduler` live in
  [`services/sync/scheduler.ts`](../server/src/services/sync/scheduler.ts:1);
  disabled by default (`SYNC_ENABLED=false`), armed only by `src/index.ts`, stopped
  on `SIGTERM`/`SIGINT`, inert in tests. Manual sync always works via `POST /api/sync`.
- **Isolation.** Per-database and per-item failures are recorded as safe messages
  and never abort the run; `syncUser` never throws.
- **No secrets.** Only safe messages, counts, and task ids leave the server — never
  a Notion token or a raw Notion payload.

See [notion-integration.md](notion-integration.md#10-synchronization-phase-16) for the
full pull/push/watermark/conflict/loop-prevention rules and the HTTP contracts.

## Phase 19 — production operations

- **Health endpoints.** `GET /health` is a dependency-free liveness probe (always
  `200`, no I/O). `GET /health/ready` is a readiness probe that reports
  configuration **booleans only** (`supabase`, `ai`, `notion`, `encryption`, plus
  the scheduler flags and uptime); it answers `200` when Supabase is configured
  and `503` otherwise. Neither exposes a URL, key, or token. They live in
  [`routes/health.ts`](../server/src/routes/health.ts:1) and are wired in
  [`app.ts`](../server/src/app.ts:1).
- **Graceful shutdown.** `src/index.ts` stops all schedulers first, then closes
  the HTTP server and drains in-flight requests, with a 10-second forced-exit
  timeout so `SIGTERM`/`SIGINT` never hang. See
  [deployment.md](deployment.md#9-scheduler--single-instance-caveat).
- **Single-instance schedulers.** Work-claiming is idempotent, but the tickers are
  process-local; run them in one instance (or add a distributed lock) when scaling
  horizontally — see [deployment.md](deployment.md#9-scheduler--single-instance-caveat).
