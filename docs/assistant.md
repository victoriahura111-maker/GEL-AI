# Assistant

Describes how the AI Virtual Task Assistant orchestrates conversations, intent handling, and task execution.

Phase 5 implements intent understanding, **Phase 10 completes the create-task
path end-to-end**, and **Phase 11 adds task updates** (edit, complete, cancel,
delete, move, and reminder edits). A recognised intent produces a confirm-ready
card (with the resolved Notion database attached for creation, or the resolved
target task for updates), and the user's explicit confirmation
(`POST /api/assistant/actions`) performs the mutation, mirrors it locally, and
appends an audit row. The assistant **never auto-creates or auto-updates** —
everything is confirm-only. Reminder delivery, notifications, and the follow-up
engine are implemented (Phases 13–15), and Notion synchronization is implemented
(Phase 16, see [notion-integration.md](notion-integration.md#10-synchronization-phase-16)).

> **"Awaiting update".** The dashboard's _Awaiting Update_ bucket is a
> **read-only view**, not an action. The Phase 15 follow-up engine sets
> `awaiting_follow_up=true` on tasks it has chased, and the bucket prefers that
> flag; when the flag is absent it falls back to the Phase 12 derivation (open
> tasks overdue or due within the next 48 hours, in the user's timezone). Viewing
> the bucket messages or mutates nothing; only the follow-up engine sends
> chase-ups and only an explicit response/confirmation mutates a task.

## Endpoint contract

`POST /api/assistant/messages` — requires a Supabase Bearer token (`authenticate`).

Request body (validated by [`assistantMessageSchema`](../server/src/validators/assistant.ts:21)):

```json
{
  "content": "Create a task to write my report tomorrow at 5pm",
  "messages": [
    { "role": "user", "content": "Hi" },
    { "role": "assistant", "content": "Hello! How can I help?" }
  ]
}
```

- `content` — required, trimmed, non-empty, max 4000 characters.
- `messages` — optional prior turns; capped at 20 messages and 4000 characters each.

Success response `200`:

```json
{
  "message": {
    "role": "assistant",
    "content": "I have prepared this task.",
    "cards": [
      {
        "type": "task",
        "title": "Write report",
        "due": "2026-10-03 at 17:00",
        "dueDate": "2026-10-03T17:00:00",
        "priority": "high",
        "task": {
          "title": "Write report",
          "dueDate": "2026-10-03",
          "dueTime": "17:00",
          "priority": "high",
          "category": "Work Tasks",
          "description": null
        },
        "database": { "id": "a1b2c3d4-...", "title": "Work Tasks" },
        "actions": ["create", "edit", "cancel"]
      }
    ]
  }
}
```

`cards` is omitted when there is nothing renderable. Card objects match the union in [`client/src/types/assistant.ts`](../client/src/types/assistant.ts:56).

Error responses (always user-safe — no stack traces or raw model output):

| Status | Cause                                                    | Body                                                                  |
| ------ | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `400`  | Invalid request body                                     | `{ "error": "Invalid request body", "details": { ... } }`             |
| `401`  | Missing/invalid auth                                     | `{ "error": "Unauthorized" }`                                         |
| `502`  | Provider failure, network failure, or unparseable output | `{ "error": "I couldn't process that right now. Please try again." }` |
| `503`  | `AI_API_KEY`/`AI_MODEL` not configured                   | `{ "error": "The AI assistant is not configured on this server." }`   |

The caller's timezone is read from `user_profiles.timezone` (falling back to `UTC` if the profile is missing — the lookup never fails the request).

## Intent extraction pipeline

1. [`extractIntent()`](../server/src/services/ai/extractor.ts:107) builds the provider messages: system prompt + recent history + the new user message.
2. [`buildIntentSystemPrompt()`](../server/src/services/ai/prompts.ts:23) injects the current date/time and the user's timezone so relative dates resolve, enumerates the supported intents, and states the prompting rules.
3. [`createChatCompletion()`](../server/src/services/ai/provider.ts:49) calls the OpenAI-compatible provider in JSON mode.
4. The JSON output is parsed (code fences tolerated) and validated against [`intentSchema`](../server/src/validators/intent.ts:271).
5. On a validation failure the request is retried **once** with a corrective system message. If it still fails, [`IntentExtractionError`](../server/src/services/ai/errors.ts:27) is thrown and the route returns a graceful `502`.
6. [`intentToCards()`](../server/src/services/ai/toCards.ts:110) maps fully-specified `create_task`/`create_reminder` intents to client cards. Everything else (including `clarify`) produces no card.

## Supported intents

`create_task`, `update_task`, `complete_task`, `cancel_task`, `delete_task`, `postpone_task`, `reschedule_task`, `search_tasks`, `list_tasks`, `get_task`, `create_reminder`, `update_reminder`, `cancel_reminder`, `check_task_status`, `clarify`, `general`.

Every intent carries a natural-language `reply` and a `confidence` (0–1).

## Missing-information rule

The model must **never invent** data. Any field not explicitly stated or confidently inferable must be `null`/omitted and listed in `missing_information`. When an action is requested but required details are absent (for example, "remind me to finish my report" with no date), the model must return the `clarify` intent so the assistant asks a follow-up question instead of guessing or emitting a card.

## Configuration

Set these in the root `.env` (see [`.env.example`](../.env.example)):

| Variable      | Required    | Notes                                                                             |
| ------------- | ----------- | --------------------------------------------------------------------------------- |
| `AI_PROVIDER` | recommended | Label only; used for documentation/telemetry.                                     |
| `AI_API_KEY`  | **yes**     | Sent as `Authorization: Bearer`. Never logged.                                    |
| `AI_MODEL`    | **yes**     | Model name passed to the provider.                                                |
| `AI_BASE_URL` | no          | Defaults to `https://api.openai.com/v1`. Point at any OpenAI-compatible provider. |

`isAiConfigured` is true only when both `AI_API_KEY` and `AI_MODEL` are present. Without them the server still boots with a warning, and the endpoint returns `503`.

## Phase 10 — create-task end to end

Phase 10 turns a confirmed preview into a real Notion page plus a local mirror.
It is composed of four cooperating pieces:

| Piece              | File                                                                                         | Responsibility                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Database selection | [`databaseSelection.ts`](../server/src/services/notion/databaseSelection.ts:1)               | Pure decision logic choosing a database.                                        |
| Notion page writes | [`pages.ts`](../server/src/services/notion/pages.ts:1)                                       | `POST /pages`, `GET /pages/:id`, `PATCH /pages/:id` via the user-scoped client. |
| Orchestrator       | [`createTask.ts`](../server/src/services/tasks/createTask.ts:1)                              | The full create sequence + failure policy.                                      |
| Action endpoint    | [`assistantActionsController.ts`](../server/src/controllers/assistantActionsController.ts:1) | Validates the confirm action and persists the result.                           |

### Database selection rules

`selectDatabase(userId, category?)` never throws for "no databases". It resolves
in this order:

1. **Purpose** — the free-form AI `category` is normalised to a purpose
   (`work | school | projects | personal | other`) by keyword match (see
   [`CATEGORY_PURPOSE_KEYWORDS`](../server/src/services/notion/databaseSelection.ts:57)).
   The mapping tagged with that purpose (its default first) is chosen with
   `source: 'purpose'`.
2. **Default** — otherwise the user's `is_default` mapping, `source: 'default'`.
3. **Single** — otherwise the user's only mapping, `source: 'single'`.
4. **Ambiguous** — otherwise `{ status: 'needs_choice', candidates }`.
5. **Empty** — no mappings ⇒ `{ status: 'no_databases', candidates: [] }`.

An explicitly supplied `databaseId` is **never trusted blindly**: the orchestrator
verifies it by fetching that database's schema with the caller's decrypted token,
so a foreign id fails rather than being used.

### `POST /api/assistant/actions`

Requires a Supabase Bearer token. The body is a discriminated union on `action`:

```jsonc
// Confirm a previewed task (fields from the card's `task` payload).
{
  "action": "create_task",
  "task": { "title": "Write report", "dueDate": "2026-10-03", "dueTime": "17:00",
            "priority": "high", "category": "Work Tasks", "description": null },
  "reminder": { "datetime": "2026-10-03T16:00:00.000Z", "timezone": "Africa/Lagos" },
  "databaseId": "a1b2c3d4-...",   // optional; from a "which database?" pick
  "conversationId": "…"           // optional
}

// Benign acknowledgement, no writes.
{ "action": "cancel", "conversationId": "…" }
```

| Outcome                          | Status        | Body                                                                    |
| -------------------------------- | ------------- | ----------------------------------------------------------------------- |
| Created                          | `200`         | `{ message, conversationId, task, notionUrl, database }`                |
| Needs a database                 | `200`         | `{ message, conversationId, needsDatabase: true, candidates }`          |
| No databases mapped              | `200`         | `{ message, conversationId, needsDatabase: true, candidates: [] }`      |
| Cancel                           | `200`         | `{ message, conversationId }`                                           |
| Invalid body                     | `400`         | `{ error: "Invalid action request", details }`                          |
| Notion not connected / reconnect | `409`         | `{ error }` (safe message)                                              |
| Notion not found / rate limited  | `404` / `429` | `{ error }`                                                             |
| Unmappable database              | `422`         | `{ error }`                                                             |
| Any other failure                | `502`         | `{ error: "I couldn't create that task right now. Please try again." }` |

On success the assistant's confirmation message is persisted to the conversation
with a `task` card carrying `notionUrl` (rendered as **View in Notion**). The text
follows the product example, e.g.
`✓ Task created — Write report, Due: 2026-10-03 at 17:00, Database: Work Tasks, Reminder: …`.

### Creation sequence (orchestrator)

1. **Validate** the input with Zod (defense-in-depth on top of the route).
2. **Resolve the database** — explicit `databaseId` (verified via schema fetch)
   or `selectDatabase`. `needs_choice` ⇒ `needs_database` and **no Notion call**;
   none mapped ⇒ `no_databases`.
3. **Fetch the schema** (`getDatabaseSchema`, `fresh`), then
   **`resolvePropertyMapping`** → **`buildNotionProperties`**.
4. **Create the Notion page** (`POST /pages`).
5. **Persist the mirror** (`assistant_tasks`) with `source_of_change: 'assistant'`,
   `sync_status: 'synced'`, `last_synced_at`.
6. **Persist an optional `pending` reminder** (`assistant_reminders`) — recorded
   only, never delivered (Phase 13).
7. **Append an audit row** (`assistant_audit_logs`, `action: 'task_created'`,
   `tool_name: 'create_task'`).

### Failure policy

- **Notion fails** ⇒ no local row is written; the typed `NotionApiError`
  propagates and the endpoint returns a safe message.
- **Page created but the mirror write fails** ⇒ the error is logged and the
  **Notion URL is still returned** (`task: null`); the URL is never lost.
- **Reminder/audit writes fail** ⇒ best-effort; they never fail the request.

### Assistant response enrichment

[`enrichCreateTaskCards()`](../server/src/controllers/assistantController.ts:106)
attaches the resolved database to the `task` card. When the choice is ambiguous it
**replaces** the preview with a `confirmation` card listing candidate databases
("Which database should I use for this task?"), carrying the task payload so the
user's pick confirms creation directly. Missing required fields still produce a
`clarify` reply (no card). Enrichment is best-effort: a mapping-lookup failure
leaves the preview card untouched.

### Client flow

- **Create Task** ⇒ `postAssistantAction({ action: 'create_task', task, reminder, databaseId })`;
  the returned assistant message (with the created card + `notionUrl`) is appended.
- **Edit** ⇒ sends a follow-up chat message so the AI re-extracts.
- **Cancel** ⇒ `postAssistantAction({ action: 'cancel' })`.
- Buttons are disabled while a card action is in flight; errors are surfaced.

## Phase 11 — updating tasks via the assistant

Phase 11 adds the **update** family end-to-end: resolving which task the user
means, proposing the change on a confirm-only card, and applying it to Notion
plus the local mirror. Supported user flows include _"Move my report to
Monday."_, _"Change the priority to high."_, _"Mark it completed."_, _"Put this
in my personal tasks."_, _"Cancel the presentation."_, and _"Change the
reminder."_

### Task resolution + disambiguation

[`resolveTask(userId, identifier)`](../server/src/services/tasks/resolveTask.ts:1)
finds the mirror task a message refers to. It is **always user-scoped** (every
query filters on `user_id`).

- The `identifier` is matched case-insensitively against the task **title and
  category** (`findTasksByTitleFragment` for the title, plus category matches
  merged from the user's task list).
- Candidates are ranked deterministically: **exact > prefix > substring**
  (a category match ranks last), then **open before closed**, then
  **nearest due date**, then most recently created.
- Two candidates are considered _indistinguishable_ only when their rank,
  open/closed state **and** due date all agree. Then:
  - exactly one top candidate ⇒ `{ status: 'found', task }`
  - more than one ⇒ `{ status: 'ambiguous', candidates }`
  - none ⇒ `{ status: 'not_found' }`
- With **no identifier**, the most recently updated **open** task is returned
  (or `not_found`). Another user's tasks can never be returned.

### Assistant message flow (confirm-only)

For the `update_task | complete_task | cancel_task | delete_task |
postpone_task | reschedule_task` intents, the controller calls `resolveTask` and
emits one of:

| Resolution  | Reply                                                | Card                                                                                                                          |
| ----------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `found`     | the model's reply                                    | a **`task_update`** card describing the change, carrying `{ taskId, changes, action }` and Confirm/Cancel                     |
| `ambiguous` | "I found N tasks that match. Which one do you mean?" | a **`task_select`** card listing candidates (`{ taskId, title, dueDate?, database? }`) plus the carried `{ action, changes }` |
| `not_found` | a clarification question                             | none                                                                                                                          |

**Nothing is mutated from the chat message alone.** A mutation runs only when the
user confirms (a `task_update` Confirm, or picking a candidate on a
`task_select`), which POSTs the structured action below.

### `POST /api/assistant/actions` — extended contract

The discriminated union on `action` now includes:

```jsonc
{ "action": "update_task",     "taskId": "…", "changes": { "dueDate": "2026-10-06" }, "conversationId": "…" }
{ "action": "complete_task",   "taskId": "…", "conversationId": "…" }
{ "action": "cancel_task",     "taskId": "…", "conversationId": "…" }
{ "action": "delete_task",     "taskId": "…", "conversationId": "…" }
{ "action": "move_task",       "taskId": "…", "databaseId": "…", "conversationId": "…" }
{ "action": "update_reminder", "reminderId": "…", "scheduledFor": "…", "timezone": "…", "conversationId": "…" }
{ "action": "cancel_reminder", "reminderId": "…", "conversationId": "…" }
```

`changes` accepts `title`, `description`, `dueDate`, `dueTime`, `timezone`,
`priority`, `status`, `category`, and `databaseId`.

Each returns `{ message, conversationId, task?, notionUrl?, warnings? }` with a
persisted assistant confirmation (e.g. _"Done. I've moved the deadline to Monday
and updated the Notion task."_). Errors are user-safe:

| Status        | Cause                                                    |
| ------------- | -------------------------------------------------------- |
| `400`         | Invalid payload (Zod)                                    |
| `404`         | Task/reminder not found (incl. **ownership** violations) |
| `409`         | Notion not connected / reconnect required                |
| `422`         | Unmappable database                                      |
| `429` / `502` | Notion rate limit / upstream failure                     |

### Update sequence (`applyTaskUpdate`)

1. Validate the changes; **load** the task (`getTaskById`, user-scoped) — missing ⇒ `not_found`.
2. Resolve whether this is a **move** (explicit `databaseId`, or a `category`
   change that maps to a different database via `selectDatabase`).
3. **In-place update**: fetch the task's database schema (user token) →
   `resolvePropertyMapping` → `buildNotionProperties` with **only the changed
   properties** → `updatePage`.
   - Status maps to the Notion option name (`completed` → "Done", etc.). When
     Notion has **no matching status option** the status property is **omitted**
     and a **warning** is returned; the mirror is still updated locally.
4. **Move**: create the replacement page in the target database **first**
   (`createNotionPage`, full property set), then **archive** the original
   (`archivePage`), then update the mirror's `notion_page_id`,
   `notion_database_id`, and `notion_url`.
5. **Update the mirror** with `source_of_change: 'assistant'`,
   `sync_status: 'synced'`, `last_synced_at`.
6. **Append an audit row**: `task_updated` / `task_completed` / `task_cancelled`
   / `task_moved` (with the matching `tool_name` and `task_id`).

### Delete sequence (`deleteTask`)

1. Load the task (user-scoped) — missing ⇒ `not_found`.
2. `archivePage` the Notion page (archive, **not** hard-delete, so it stays
   recoverable in Notion trash). If Notion fails, the typed error propagates and
   the mirror is **preserved**.
3. **Cancel pending reminders** (`listRemindersForTask` + `cancelReminder`).
4. `deleteTaskRecord` the mirror row.
5. Audit `task_deleted`.

Confirm-before-delete applies: `delete_task` only runs from the confirmed card.

### Reminder changes (minimal)

`update_reminder` edits the pending row via
[`updateReminder`](../server/src/services/reminders/repository.ts:1);
`cancel_reminder` uses `cancelReminder`. Full scheduling and delivery are
implemented by the Phase 13 reminder engine (see
[reminders.md](reminders.md)). If no pending reminder exists the action returns
`404` (not owned / missing); when an update supplies no new schedule it still
succeeds with a warning rather than failing.

### Failure policy (updates)

- **Notion fails** ⇒ the typed `NotionApiError` propagates and the **mirror is
  left unchanged** (no partial local state).
- **Notion succeeds but the mirror write fails** ⇒ the Notion result (URL) is
  still returned, with a warning.
- **Move + archive failure** ⇒ the new page is kept, the original page is kept
  (both exist), the mirror points at the **new** page, and a warning explains the
  situation — **user data is never lost**.
- **Status option missing** ⇒ status updated locally only, with a warning.

### Client

- [`TaskUpdateCard`](../client/src/components/chat/TaskUpdateCard.tsx:1) renders the
  proposed change + Confirm/Cancel and posts the carried `{ taskId, changes }`.
- [`TaskSelectCard`](../client/src/components/chat/TaskSelectCard.tsx:1) lists the
  candidates; picking one posts the carried change for that task.
- Buttons are disabled while in flight; errors surface via `ChatContext`.

## Phase 15 — follow-up engine

The follow-up engine proactively chases **open tasks that are due soon or
overdue** and lets the user resolve them with one tap. It reuses the reminder
worker pattern and the notification layer; it never invents new task state.

### What gets chased (candidate rules)

`selectFollowUpCandidates(nowIso)` (in
[`services/followup/candidates.ts`](../server/src/services/followup/candidates.ts:1))
picks a task when it is **all** of:

- **open** — status is not `completed`/`cancelled` (`blocked` **is** eligible), and
- **due date present**, and
- **due soon or overdue** — its deadline is within `FOLLOW_UP_LEAD_HOURS`
  (default 24) or already past, and
- **under the per-task cap** — `follow_up_count < FOLLOW_UP_MAX_PER_TASK`
  (default 3), and
- **past the minimum interval** — `last_follow_up_at` is older than
  `FOLLOW_UP_MIN_INTERVAL_HOURS` (default 20).

Deadlines are resolved to absolute instants in the **task/user timezone** using
the same dependency-free `Intl` approach as Phase 12 (a date-only deadline means
23:59 that day). `evaluateFollowUpCandidates` is the pure, unit-tested core;
`selectFollowUpCandidates` loads open tasks and delegates (never throws).

### Card variants

Each follow-up is delivered as a message **plus** an interactive `follow_up`
card (carried on the notification and appended to the proactive assistant
message):

| `kind`     | Prompt                                                          | Buttons                                                 |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `due_soon` | Your "…" is due `<tomorrow / in N hours>`. How is it going?     | `completed`, `in_progress`, `blocked`, `need_more_time` |
| `overdue`  | Your "…" was due `<yesterday / N days ago>`. Would you like to: | `mark_completed`, `continue_working`, `move_deadline`   |

### Response handling

`handleFollowUpResponse(userId, { taskId, response, reason?, newDeadline? })`
(in [`services/followup/respond.ts`](../server/src/services/followup/respond.ts:1))
maps the answer to a task mutation through `applyTaskUpdate`, always clears
`awaiting_follow_up`, audits `follow_up_response`, and enforces ownership
(`getTaskById` is `user_id`-scoped → `not_found`):

| Response                           | Effect                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed` / `mark_completed`     | status `completed`                                                                                                                             |
| `in_progress` / `continue_working` | status `in_progress` (for an overdue card, `continue_working` simply means "I'm still on it")                                                  |
| `blocked`                          | status `blocked` + stores `blocking_reason`; replies **"What is blocking you?"** until a reason is given                                       |
| `need_more_time` / `move_deadline` | requires `newDeadline`, parsed with the reminder `schedule` helpers → applies a new `due_date`/`due_time` (a date-only answer clears the time) |

#### Action contract

`POST /api/assistant/actions` gains three actions:

```ts
{ action: 'follow_up_response', taskId, response, reason? }
{ action: 'follow_up_reason', taskId, reason }
{ action: 'follow_up_new_deadline', taskId, deadline | date | datetime, timezone? }
```

Each returns the standard `{ message, conversationId, task?, notionUrl?, warnings? }`
and persists an assistant confirmation (e.g. _"Got it. I've updated the task to
In Progress."_ / _"Done. I've moved the deadline to 2026-10-12…"_). A missing
deadline on `follow_up_new_deadline` is a `400`; a foreign task is a `404`.

#### Conversational replies

When the client omits `messages` (so the server hydrates the stored turns,
including proactive follow-ups), a free-text answer to a follow-up question is
resolved directly: `detectFollowUpExpectation` recognises the _"What is
blocking you?"_ / _"Would you like to:"_ prompts, recovers the quoted task title,
resolves it with `resolveTask`, and applies the reply. This is a **best-effort
convenience** — the button/card path is the primary flow and works regardless.

### Anti-spam

- Per-task cap (`FOLLOW_UP_MAX_PER_TASK`, default 3) and minimum interval
  (`FOLLOW_UP_MIN_INTERVAL_HOURS`, default 20) are enforced at selection time.
- The engine applies a **hard per-tick cap** (`DEFAULT_FOLLOW_UP_TICK_LIMIT`).
- Sending a follow-up sets `awaiting_follow_up = true`, `last_follow_up_at = now`,
  and increments `follow_up_count`; every response clears the flag.
- The dashboard's _Awaiting Update_ bucket now prefers `awaiting_follow_up` when
  set, falling back to the Phase 12 48-hour derivation.

### Client

[`FollowUpCard`](../client/src/components/chat/FollowUpCard.tsx:1) renders the
prompt + the correct buttons per `kind`. **Blocked** reveals an inline reason
textarea (posts `follow_up_reason`); **Need more time / Move deadline** reveal an
inline date-time input (posts `follow_up_new_deadline`); the other buttons post
`follow_up_response` directly. Buttons are disabled while in flight and errors
surface via `ChatContext`.

> The worker lifecycle (interval, overlap guard, `SIGTERM` shutdown) and the
> flow diagram live in [architecture.md](architecture.md); the notification
> plumbing (cards on `AppNotification`) is in [notifications.md](notifications.md).
