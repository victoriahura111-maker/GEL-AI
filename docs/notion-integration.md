# Notion Integration

This document covers **Phase 7** (connecting a user's Notion workspace via OAuth
2.0), **Phase 8** (database discovery + purpose configuration), **Phase 9**
(schema inspection + reusable property mapping), **Phase 10** (creating a Notion
page for a task, plus the database-selection rules), **Phase 11** (updating,
completing, cancelling, deleting, and moving existing pages) and **Phase 16**
(bidirectional synchronization — §10). It describes the authorization flow, how
the OAuth `state` is protected, how the Notion access token is encrypted at rest,
how databases are discovered and mapped to purposes, how a database's properties
are inspected and mapped to internal task fields, how pages are created/updated,
the exact HTTP contracts, what is and is not exposed to the browser, and the
environment variables you must set.

> Scope note. Phase 10 wrote the first Notion page; Phase 11 added updating,
> completing, cancelling, deleting, and moving existing pages; Phase 16
> reconciles the local mirror with Notion in both directions. All reads and
> writes remain user-scoped through the encrypted connection, and the access
> token never leaves the server.

---

## 1. Overview

The integration uses Notion's public OAuth 2.0 flow with a confidential server
client. The browser only ever sees Notion's public authorization URL; the client
secret and the resulting access token stay on the server.

```
┌──────────┐        ┌──────────────┐        ┌────────────┐        ┌──────────┐
│ Browser  │        │  API server  │        │   Notion   │        │ Supabase │
│ (React)  │        │  (Express)   │        │  OAuth     │        │ Postgres │
└────┬─────┘        └──────┬───────┘        └─────┬──────┘        └────┬─────┘
     │                     │                      │                    │
     │ 1. GET /api/notion/oauth/start (Bearer)    │                    │
     │────────────────────>│                      │                    │
     │                     │ create signed state  │                    │
     │ 2. { authorizationUrl }                    │                    │
     │<────────────────────│                      │                    │
     │ 3. window.location.assign(authorizationUrl)│                    │
     │───────────────────────────────────────────>│                    │
     │ 4. user approves; Notion redirects to      │                    │
     │    NOTION_REDIRECT_URI ?code&state         │                    │
     │<───────────────────────────────────────────│                    │
     │ 5. GET /api/notion/oauth/callback?code&state (browser redirect, no Bearer)
     │────────────────────>│                      │                    │
     │                     │ verify state (sig/exp/single-use/user)     │
     │                     │ 6. POST /v1/oauth/token (Basic, secret)    │
     │                     │─────────────────────>│                    │
     │                     │ 7. { access_token, workspace... }          │
     │                     │<─────────────────────│                    │
     │                     │ encrypt token        │                    │
     │                     │ 8. upsert notion_connections (user_id)     │
     │                     │───────────────────────────────────────────>│
     │ 9. 302 -> APP_URL/settings/notion?notion=connected                │
     │<────────────────────│                      │                    │
     │ 10. GET /api/notion/connection (Bearer) -> status (no token)      │
     │────────────────────>│───────────────────────────────────────────>│
```

---

## 2. OAuth flow steps

1. **Start** — the authenticated client calls `GET /api/notion/oauth/start`.
   The server mints a signed `state` bound to the caller's user id and returns
   the public Notion authorization URL. No Notion secret is involved in the
   response.
2. **Authorize** — the browser navigates to the returned URL (Notion's
   `https://api.notion.com/v1/oauth/authorize`). The user picks a workspace and
   approves the requested access.
3. **Callback** — Notion redirects the browser to `NOTION_REDIRECT_URI`
   (`GET /api/notion/oauth/callback`) with `code` and `state`. This endpoint is
   **not** protected by a Bearer token: it is a top-level browser redirect.
   Trust comes entirely from the signed, single-use `state`.
4. **Exchange** — the server validates the state, then performs the confidential
   code exchange `POST https://api.notion.com/v1/oauth/token` using HTTP Basic
   auth (`client_id:client_secret`) and the pinned `Notion-Version` header.
5. **Store** — the returned access token is encrypted with AES-256-GCM and
   upserted into `public.notion_connections`, keyed uniquely by `user_id`.
6. **Return** — the server `302`-redirects the browser to
   `${APP_URL}/settings/notion?notion=connected`. On any failure it redirects to
   `...?notion=error&reason=<safe-code>` instead.

---

## 3. State validation (signed + expiring + single-use + user-bound)

Implemented in [`server/src/services/notion/oauthState.ts`](../server/src/services/notion/oauthState.ts).

| Property          | How it is enforced                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signed**        | HMAC-SHA256 over the base64url-encoded JSON payload. The signing key is derived from `ENCRYPTION_KEY` via scrypt with a fixed, domain-separated salt.                            |
| **User-bound**    | The payload contains `userId` (taken from the verified token at `/start`). The callback derives the acting user **only** from this signed payload, never from a query parameter. |
| **Expiring**      | `exp` is `iat + 10 minutes`. Expired states are rejected.                                                                                                                        |
| **Single-use**    | Each state carries a random 16-byte `nonce`. Consumed nonces are tracked in an in-process TTL map; a replay is rejected with `state_replayed`.                                   |
| **Constant-time** | Signatures are compared with `crypto.timingSafeEqual` (via `safeEqual`).                                                                                                         |

Wire format: `<base64url(payload)>.<base64url(hmac)>`.

**Single-instance limitation.** The consumed-nonce store is process-local.
Multiple server instances (or serverless replicas) each keep their own store, so
replay protection is best-effort across instances. Signature, expiry, and user
binding still hold in all cases. For multi-instance deployments, back the
consumed-nonce check with a shared store (e.g. Redis or Postgres).

---

## 4. Token encryption at rest

Implemented in [`server/src/utils/encryption.ts`](../server/src/utils/encryption.ts).

- **Algorithm:** AES-256-GCM (authenticated encryption — tampering is detected).
- **Key derivation:** `scrypt(ENCRYPTION_KEY, fixed-salt, 32)` → deterministic
  32-byte key. `ENCRYPTION_KEY` must be **at least 32 characters**.
- **Wire format:** `v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>` (versioned for
  future key/algorithm rotation).
- **Fail closed:** a missing/short key raises a typed configuration error
  (never a hard-coded fallback); an auth-tag mismatch (tampering/wrong key)
  raises a typed `tampered` error instead of returning data.
- Only the ciphertext is written to `access_token_encrypted`. The token is
  decrypted **only** by `getConnection()` for internal server-side use in later
  phases.

`db migration` [`0006_notion_connections.sql`](../database/migrations/0006_notion_connections.sql)
already provides the table (one row per user, RLS per user). No new migration is
required.

---

## 5. Endpoints and contracts

Base path: `/api/notion`.

| Method   | Path                             | Auth            | Success                                                      | Errors                                                                                                                |
| -------- | -------------------------------- | --------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/oauth/start`                   | Bearer token    | `200 { "authorizationUrl": string }`                         | `401` unauthorized · `503` Notion not configured                                                                      |
| `GET`    | `/oauth/callback`                | none (redirect) | `302` → `APP_URL/settings/notion?notion=connected`           | `302` → `...?notion=error&reason=<code>`                                                                              |
| `GET`    | `/connection`                    | Bearer token    | `200 NotionConnectionSummary`                                | `401` · `500`                                                                                                         |
| `DELETE` | `/connection`                    | Bearer token    | `200 { "connected": false }`                                 | `401` · `500`                                                                                                         |
| `GET`    | `/databases`                     | Bearer token    | `200 { "databases": NotionDatabase[] }`                      | `401` · `409` not connected / reconnect required · `429` · `502`                                                      |
| `GET`    | `/databases/:databaseId/schema`  | Bearer token    | `200 { "database", "properties", "mapping", "unsupported" }` | `400` invalid id · `401` · `409` not connected / reconnect required · `404` · `422` no title property · `429` · `502` |
| `PUT`    | `/databases/:databaseId/mapping` | Bearer token    | `200 { "mapping": NotionDatabaseMapping }`                   | `400` invalid id/purpose · `401` · `503` not configured · `500`                                                       |
| `DELETE` | `/databases/:databaseId/mapping` | Bearer token    | `200 { "removed": boolean }`                                 | `400` invalid id · `401` · `500`                                                                                      |

`NotionConnectionSummary` (never contains the token):

```jsonc
{
  "connected": true,
  "workspaceName": "Acme Workspace",
  "workspaceIcon": "https://...",
  "workspaceId": "abc-123",
  "connectedAt": "2026-10-02T21:00:00.000Z",
}
```

Safe callback `reason` codes: `access_denied`, `state_expired`, `state_replayed`,
`state_invalid`, `state_malformed`, `missing_code`, `exchange_failed`,
`network_error`, `not_configured`, `unknown`.

### 5.1 Database discovery via `/search`

Implemented in [`server/src/services/notion/client.ts`](../server/src/services/notion/client.ts).
The client reads the caller's **decrypted** access token from the connection
repository and sends it as `Authorization: Bearer <token>` with the pinned
`Notion-Version: 2022-06-28` header.

`GET /api/notion/databases` calls `POST https://api.notion.com/v1/search` with:

```jsonc
{
  "filter": { "property": "object", "value": "database" },
  "sort": { "direction": "descending", "timestamp": "last_edited_time" },
  "page_size": 100,
}
```

- **Pagination.** `next_cursor` is followed for at most **5 pages**
  ([`MAX_SEARCH_PAGES`](../server/src/services/notion/client.ts:29)) to bound a
  single request. When more pages exist, the user can use **Refresh** to re-run
  discovery.
- **Shared-only visibility.** Notion's capability model means only databases the
  user has explicitly **shared with the integration** are returned. A database
  that exists in the workspace but was never shared does not appear.
- **Normalisation.** Each result is reduced to
  `{ id, title, url, icon }` — never the raw Notion payload:
  - `id` is normalised to dashed lowercase (Notion returns either dashed or
    compact form; both are accepted everywhere).
  - `title` is the concatenated `title[].plain_text`, falling back to
    `"Untitled"` when missing/empty.
  - `icon` is the emoji or image URL when present, else `null`.
- No retries are performed in this phase; upstream failures are mapped to a typed,
  user-safe error (see §5.4).

### 5.2 Purpose model

Every discovered database can be tagged with exactly one purpose so the assistant
can pick the right database for a task:

| Purpose    | Meaning                                   |
| ---------- | ----------------------------------------- |
| `work`     | Work tasks and projects.                  |
| `personal` | Personal tasks and errands.               |
| `school`   | Study, coursework, and assignments.       |
| `projects` | Side projects / general project tracking. |
| `other`    | Anything that does not fit the above.     |

Persisted in [`public.notion_database_mappings`](../database/migrations/0007_notion_database_mappings.sql)
(no new migration required): one row per `(user_id, notion_database_id)`, with
`database_title`, `purpose`, and `is_default`. **At most one default per user** —
setting a default clears the others (enforced in both the repository and the
database layer). All reads/writes are scoped by `user_id`.

### 5.3 Mapping contracts

`GET /api/notion/databases` merges the live Notion databases with the caller's
saved mappings:

```jsonc
{
  "databases": [
    {
      "id": "a1b2c3d4-1234-5678-9abc-def012345678",
      "title": "Work Tasks",
      "url": "https://www.notion.so/...",
      "icon": "📋",
      "purpose": "work", // or null when unmapped
      "isDefault": true,
    },
  ],
}
```

`PUT /api/notion/databases/:databaseId/mapping` — body (Zod-validated, strict):

```jsonc
{ "purpose": "school", "isDefault": true } // isDefault optional
```

- `purpose` must be one of `work | personal | school | projects | other`;
  anything else is rejected with `400 { "error": "Invalid mapping", "details": ... }`.
- `databaseId` accepts dashed or compact Notion ids and is normalised; a
  malformed id is rejected with `400 { "error": "Invalid Notion database id" }`.
- Returns `200 { "mapping": { notionDatabaseId, databaseTitle, purpose, isDefault } }`.
- Omitting `isDefault` preserves the existing flag.

`DELETE /api/notion/databases/:databaseId/mapping` returns
`200 { "removed": boolean }` (`false` when the caller had no mapping — including
cross-user attempts, which match nothing because of the `user_id` filter).

### 5.4 Error semantics (discovery + mapping)

| Situation                              | Status | `error` message                                               |
| -------------------------------------- | ------ | ------------------------------------------------------------- |
| No stored Notion connection            | `409`  | `Connect Notion first`                                        |
| Upstream `401`/`403` (revoked/expired) | `409`  | `Reconnect Notion to continue`                                |
| Upstream `404`                         | `404`  | `That Notion resource could not be found.`                    |
| Upstream `429` (rate limited)          | `429`  | `Notion is rate limiting requests. Please try again shortly.` |
| Upstream network / unreadable / 5xx    | `502`  | user-safe message (never the raw body)                        |
| Supabase unconfigured on a write       | `503`  | `Could not save your Notion database settings`                |
| Invalid id or purpose                  | `400`  | `Invalid Notion database id` / `Invalid mapping`              |

Errors are typed (`NotionApiError` with a stable `code` plus the upstream
`status`). The access token, raw Notion payloads, and upstream error bodies are
**never** logged or returned to the client.

### 5.5 Schema inspection (`GET /api/notion/databases/:databaseId/schema`)

Implemented in [`server/src/services/notion/schema.ts`](../server/src/services/notion/schema.ts:1),
built on [`getDatabaseRaw()`](../server/src/services/notion/client.ts:244) (`GET /databases/:id`).
The client reads the caller's **decrypted** access token exactly like discovery
(same Bearer + `Notion-Version: 2022-06-28` headers, same typed error mapping).

Notion returns `properties` as an **object keyed by property name**; the service
flattens it into an ordered **array** so the mapping heuristics are deterministic:

```ts
interface NotionDatabaseSchema {
  id: string; // normalised dashed lowercase
  title: string; // top-level title[].plain_text, else "Untitled"
  properties: Array<{
    id: string;
    name: string; // the object key
    type: string; // any Notion type; unsupported types are kept as-is
    options?: Array<{ id?: string; name: string; color?: string }>;
  }>;
}
```

- `options` is populated only for `select`, `multi_select` and `status`
  (status options come from `status.options`).
- Recognised types: `title`, `rich_text`, `select`, `multi_select`, `status`,
  `date`, `checkbox`, `number`, `url`, `people`. **Any other type does not fail
  the request** — it is surfaced in the `unsupported` array instead.
- A small in-process TTL cache (`5 min`, keyed by `(userId, databaseId)`) avoids
  re-fetching an unchanged schema. It is best-effort and never crosses users.

The endpoint returns (never the raw provider payload):

```jsonc
{
  "database": { "id": "a1b2c3d4-...", "title": "Work Tasks" },
  "properties": [
    { "id": "title-1", "name": "Name", "type": "title" },
    {
      "id": "status-1",
      "name": "Status",
      "type": "status",
      "options": [{ "id": "o1", "name": "Done", "color": "green" }],
    },
    { "id": "formula-1", "name": "Formula", "type": "formula" },
  ],
  "mapping": { "title": "Name", "status": "Status", "unsupported": [] },
  "unsupported": [{ "name": "Formula", "type": "formula" }],
}
```

Error semantics match discovery: `409` no connection / reconnect required,
`404` not found, `400` invalid id, `429` rate limited, `502` provider failure,
`422` when the database has no `title` property (it cannot be mapped).

### 5.6 Property mapping

Implemented in [`server/src/services/notion/propertyMapping.ts`](../server/src/services/notion/propertyMapping.ts:1).
[`resolvePropertyMapping()`](../server/src/services/notion/propertyMapping.ts:146)
is a pure, deterministic function (same schema → same mapping). Candidates are
considered in schema order; ties break on schema order. Name matching is
case-insensitive, and for a given keyword list the **keyword order dominates**
(exact match beats substring for the same keyword). A property is **never
assigned to two internal fields** (a `used` set is threaded through the passes).

| Internal field         | Heuristic                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `title` **(required)** | The single `title`-type property. Throws a typed `PropertyMappingError('missing_title')` when absent.                       |
| `date`                 | Prefer a `date` property whose name contains `due` \| `deadline` \| `date` (in that order); else the first `date` property. |
| `status`               | A `status`-type property; else a `select` named `status` \| `state`.                                                        |
| `priority`             | A `select`/`multi_select` named `priority` \| `urgency`.                                                                    |
| `category`             | A `select`/`multi_select` named `category` \| `type` \| `tags` \| `project` \| `label` (excluding already-used properties). |
| `description`          | A `rich_text` named `description` \| `notes` \| `details`; else the first unused `rich_text`.                               |
| `url`                  | The first `url` property (optional).                                                                                        |
| `people`               | The first `people` property (optional; **not** resolved in Phase 9).                                                        |

The result is:

```ts
interface PropertyMapping {
  title: string;
  date?: string;
  status?: string;
  priority?: string;
  category?: string;
  description?: string;
  url?: string;
  people?: string;
  unsupported: Array<{ name: string; type: string }>;
}
```

#### Per-type value builders

[`buildNotionProperties(mapping, task)`](../server/src/services/notion/propertyMapping.ts:337)
emits the `properties` payload for a Notion page create/update. Resolved types +
options are kept in a module-private `WeakMap` keyed by the mapping object, so the
public mapping contract stays exactly as above.

| Notion type    | Emitted value                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`        | `{ title: [{ text: { content } }] }`                                                                                                                                                         |
| `rich_text`    | `{ rich_text: [{ text: { content } }] }`                                                                                                                                                     |
| `select`       | `{ select: { name } }` — case-insensitive match to an existing option when possible; otherwise the raw name is passed through so **Notion can create** the option (non-status selects only). |
| `multi_select` | `{ multi_select: [{ name }] }` (same match-or-create rule).                                                                                                                                  |
| `status`       | `{ status: { name } }` — **only** when it case-insensitively matches an existing status option; otherwise omitted, because Notion status options cannot be created implicitly.               |
| `date`         | `{ date: { start, time_zone? } }` — `due_date` + `due_time` combine to `YYYY-MM-DDTHH:mm:00`; `time_zone` is included when a timezone is supplied.                                           |
| `checkbox`     | `{ checkbox: boolean }`                                                                                                                                                                      |
| `number`       | `{ number }`                                                                                                                                                                                 |
| `url`          | `{ url }`                                                                                                                                                                                    |

Internal `priority`/`status` values are mapped to friendly option names before
matching (e.g. `not_started`→`Not started`, `in_progress`→`In progress`,
`completed`→`Done`, `blocked`→`Blocked`; `low`/`medium`/`high`→`Low`/`Medium`/`High`).
Fields whose Notion property is absent from the mapping, or whose value is
`null`/`undefined`/empty, are omitted. `people` is out of Phase 9 scope (no user
resolution) and is never written.

### 5.7 Page writes + database selection (Phase 10)

Implemented in [`server/src/services/notion/pages.ts`](../server/src/services/notion/pages.ts:1),
built on the same authenticated request helper as discovery/schema (Bearer token
from the caller's decrypted connection + `Notion-Version: 2022-06-28`). Every call
is scoped to one `userId`; the token is never logged, returned, or embedded in an
error, and only `{ id, url }` leaves the server — never a raw Notion payload.

| Function                                           | Notion call           | Body                                      | Returns       |
| -------------------------------------------------- | --------------------- | ----------------------------------------- | ------------- |
| `createNotionPage(userId, databaseId, properties)` | `POST /v1/pages`      | `{ parent: { database_id }, properties }` | `{ id, url }` |
| `retrievePage(userId, pageId)`                     | `GET /v1/pages/:id`   | —                                         | `{ id, url }` |
| `updatePage(userId, pageId, properties)`           | `PATCH /v1/pages/:id` | `{ properties }`                          | `{ id, url }` |

Database/page ids are normalised to dashed lowercase in the request path and in
the returned id. Errors map exactly as in §5.4 (`NotionApiError` codes;
`401`/`403` ⇒ reconnect required).

**Which database?** The orchestrator uses
[`selectDatabase()`](../server/src/services/notion/databaseSelection.ts:131),
which resolves in order: category→purpose (keyword match) → the user's `default`
→ the user's `single` mapping → `needs_choice` (candidates) → `no_databases`.
An explicit `databaseId` supplied by the client is verified by fetching that
database's schema **with the caller's token**, so an id the user cannot access
fails instead of being trusted.

**Page creation is reachable only through the confirm action**
(`POST /api/assistant/actions`, see [assistant.md](assistant.md#phase-10--create-task-end-to-end));
the assistant never auto-creates. There is no standalone Notion write endpoint in
this phase, so the browser can never trigger a page write directly.

---

## 6. What is / is not exposed to the browser

| Exposed to the browser                                                                                                                     | Never exposed                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| The public Notion **authorization URL** (`client_id`, `redirect_uri`, `state`, `response_type`, `owner`). `client_id` is public by design. | `NOTION_CLIENT_SECRET`                                             |
| Connection summary metadata (workspace name/icon/id, connected-at, `connected` flag).                                                      | The Notion **access token** (or its ciphertext).                   |
| Short, fixed `reason` codes on error redirects.                                                                                            | Raw Notion API responses, tokens, secrets, or `error_description`. |

The authorization URL returned by `/oauth/start` contains only the public
`client_id`; the secret is used exclusively server-side in the Basic-auth header.

---

## 7. Environment variables to configure

Copy `.env.example` to `.env` at the repository root and set:

| Variable               | Required           | Description                                                                                                                                          |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTION_CLIENT_ID`     | yes (Notion)       | OAuth public integration client id.                                                                                                                  |
| `NOTION_CLIENT_SECRET` | yes (Notion)       | OAuth client secret — server-only.                                                                                                                   |
| `NOTION_REDIRECT_URI`  | yes (Notion)       | Must exactly match the URI registered with Notion (see below).                                                                                       |
| `ENCRYPTION_KEY`       | yes (tokens/state) | **At least 32 characters.** Used to derive the AES key and the state-signing key. Rotating it invalidates existing ciphertexts and in-flight states. |
| `APP_URL`              | yes                | Frontend origin used for post-callback redirects, e.g. `http://localhost:5173`.                                                                      |
| `API_URL`              | yes                | Public base URL of this API, e.g. `http://localhost:4000`.                                                                                           |
| `SYNC_ENABLED`         | no                 | Arms the **periodic** sync worker (Phase 16). Default `false` — opt-in. Manual `POST /api/sync` works regardless.                                    |
| `SYNC_TICK_MS`         | no                 | Periodic sync interval in ms (default `900000` = 15 min).                                                                                            |
| `SYNC_MIN_INTERVAL_MS` | no                 | Per-user cooldown for the manual sync endpoint (default `10000` = 10 s).                                                                             |

### Notion redirect URI to register

In your Notion integration settings, add this redirect URI (it must match
`NOTION_REDIRECT_URI` character-for-character):

```
http://localhost:4000/api/notion/oauth/callback        # local development
https://<your-api-domain>/api/notion/oauth/callback    # production
```

When any of `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, or `NOTION_REDIRECT_URI`
is missing, `isNotionConfigured` is `false`: the server still boots with a
warning, and `GET /api/notion/oauth/start` responds `503` rather than crashing.

---

## 8. Testing

- `tests/server/oauthState.test.ts` — signature, expiry, single-use, user binding.
- `tests/server/encryption.test.ts` — round-trip, tamper detection, config guards.
- `tests/server/notionOAuth.test.ts` — start URL, callback success/error paths,
  encrypted storage, token never leaked.
- `tests/server/notionConnection.test.ts` — status never includes the token;
  disconnect removes only the caller's row.
- `tests/server/notionClient.test.ts` — `/search` request shape, pagination +
  page cap, normalisation, `401/403` → reconnect, no connection → `not_connected`.
- `tests/server/databaseMappingRepository.test.ts` — user-scoped upsert/list/
  delete, single-default enforcement, `getMappingsByPurpose` filtering.
- `tests/server/notionDatabasesRoute.test.ts` — merged purpose/default, `409`
  not connected/reconnect, purpose-enum validation, delete, cross-user isolation.
- `tests/server/notionSchema.test.ts` — schema flattening (incl. select/
  multi_select/status options), compact-id normalisation, TTL cache, error
  mapping (`401`/`404`/`network`), `unsupported` collection.
- `tests/server/propertyMapping.test.ts` — mapping heuristics across realistic
  shapes, no double-assignment, `missing_title`, and per-type payload builders
  (status-option constraint, case-insensitive matching, omitted values).
- `tests/server/notionSchemaRoute.test.ts` — endpoint contract, success shape,
  `409` no connection / reconnect, `404`, `400` invalid id, `502`.
- `tests/client/notionSettings.test.tsx` — connect/disconnect UI and return notices.
- `tests/client/notionDatabases.test.tsx` — discovery list rendering, purpose
  selection calling the service, empty/error states.
- `tests/server/notionToTask.test.ts` — reverse mapping (title/date/status/
  priority/category/description/url), missing/null properties, unknown-option
  fallbacks, checkbox status, multi_select category.
- `tests/server/syncEngine.test.ts` — pull create/update/skip (last-write-wins),
  push update/failure, loop prevention, archived pages, per-database isolation,
  summary shape, never-throws.
- `tests/server/syncRoute.test.ts` — manual sync summary, `400`/`409`/`429`/`503`,
  and the status endpoint shape.
- `tests/client/sync.test.tsx` — the "Sync now" control calls the service and
  renders the summary counts and any errors.

All tests run offline (Notion `fetch` and Supabase are mocked/faked).

---

## 9. Page updates, archive, and database moves (Phase 11)

Phase 11 writes to **existing** pages: field updates, status transitions, moves
between databases, and deletion. All calls reuse the user-scoped write path in
[`pages.ts`](../server/src/services/notion/pages.ts:1) built on the shared
authenticated `notionRequest` (the caller's decrypted token is sent as
`Authorization: Bearer`, with the pinned `Notion-Version` header). The token is
never logged, returned, or embedded in an error.

| Operation     | Notion call                           | Notes                                                                 |
| ------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Field update  | `PATCH /pages/:id { properties }`     | Only the **changed** properties are sent.                             |
| Archive       | `PATCH /pages/:id { archived: true }` | Used by moves (archive the original) and by `delete_task`.            |
| Move (step 1) | `POST /pages` (target database)       | A page cannot change its parent, so the replacement is created first. |
| Move (step 2) | `PATCH /pages/:id { archived: true }` | Archive the original after the replacement exists.                    |

### Move policy

A "move" (`Put this in my personal tasks.` or an explicit `databaseId`) resolves
the target database (by purpose via `selectDatabase`, verified with a schema fetch
scoped to the user's token, or the explicit id) and then:

1. **Creates** the replacement page in the target database with the **full**
   property set (`createNotionPage`).
2. **Archives** the original page (`archivePage`).
3. Updates the mirror's `notion_page_id`, `notion_database_id`, and `notion_url`.

**Partial-failure policy.** If the replacement is created but archiving the
original fails, **both pages are kept** (no data is lost), the mirror is updated
to point at the **new** page, and a warning is returned to the user explaining
that both pages now exist. `updatePage` alone is insufficient for a move because
Notion pages cannot be re-parented by a property patch.

### Deletion policy

`delete_task` **archives** the page (`archived: true`) rather than hard-deleting
it, so it remains recoverable in Notion trash. It then cancels the task's pending
reminders and removes the local mirror row. If archiving fails, the typed
`NotionApiError` propagates and the mirror is preserved.

### Tests

- `tests/server/updateTask.test.ts` — field updates, status transitions (incl. an
  omitted status option), move (create + archive + mirror), the partial-failure
  branch, delete (archive + cancel reminders + remove mirror), and typed errors
  with no mirror change.
- `tests/server/resolveTask.test.ts` — ranking, open-preferred, disambiguation,
  not-found, and user-scoping.

---

## 10. Synchronization (Phase 16)

Phase 16 reconciles the local `assistant_tasks` mirror with Notion in both
directions. The engine is
[`services/sync/engine.ts`](../server/src/services/sync/engine.ts:1)
(`syncUser(userId, { direction, now })`), reverse mapping lives in
[`services/notion/notionToTask.ts`](../server/src/services/notion/notionToTask.ts:1),
page reading in [`queryDatabasePages`](../server/src/services/notion/pages.ts), and
the watermark is persisted in
[`public.user_sync_state`](../database/migrations/0011_user_sync_state.sql).

### Endpoints

| Method | Path               | Auth   | Success           | Errors                                                                                               |
| ------ | ------------------ | ------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `POST` | `/api/sync`        | Bearer | `200 SyncSummary` | `400` invalid direction · `401` · `409` Notion not connected · `429` cooldown · `503` not configured |
| `GET`  | `/api/sync/status` | Bearer | `200 SyncStatus`  | `401` · `503` · `500`                                                                                |

`POST /api/sync` body (optional): `{ "direction": "both" | "pull" | "push" }`
(default `both`). A per-user cooldown (`SYNC_MIN_INTERVAL_MS`) answers `429` if a
sync ran within the window, so a stuck client cannot hammer Notion.

```ts
interface SyncSummary {
  direction: 'both' | 'pull' | 'push';
  pulled: { created: number; updated: number; skipped: number };
  pushed: { updated: number; failed: number };
  errors: Array<{ scope: string; message: string }>; // safe messages only
  startedAt: string;
  finishedAt: string;
}

interface SyncStatus {
  lastSyncedAt: string | null; // watermark (last successful pull)
  lastDirection: 'both' | 'pull' | 'push' | null;
  lastError: string | null;
  counts: { synced: number; pending: number; error: number };
  recentErrors: string[]; // most recent safe messages (bounded)
}
```

### Pull (Notion → local)

For each mapped database (`listMappings`): fetch the schema + resolve the mapping,
then `POST /databases/:id/query` with

```jsonc
{
  "filter": { "timestamp": "last_edited_time", "last_edited_time": { "after": "<watermark>" } },
  "sorts": [{ "timestamp": "last_edited_time", "direction": "ascending" }],
  "page_size": 100,
}
```

following `next_cursor` (bounded). Each page is reverse-mapped
(`mapNotionPageToTask`) and then:

- **No local task** → a mirror row is created (`source_of_change:'notion'`,
  `sync_status:'synced'`, `last_synced_at:now`).
- **Local task exists** → **last-write-wins** (below).
- **Archived / in trash** → the local task is marked `status:'cancelled'` and
  `sync_status:'error'` (the documented rule), so a page deleted in Notion does
  not silently keep a live local mirror.

Reverse mapping never throws: a missing/null property, an unknown status option
(falls back to `not_started`) or an unknown priority option (→ `null`) is handled
gracefully and recorded as a warning. Common status synonyms are accepted
(`Done`/`Complete` → `completed`, `Todo`/`To do` → `not_started`, `Doing` →
`in_progress`); checkbox-backed statuses map to `completed`/`not_started`.

### Conflict policy — last-write-wins

A conflict is decided by comparing the Notion `last_edited_time` against the local
row's `updated_at` (via integer timestamps, not string comparison):

- Notion **strictly newer** → apply the Notion values locally
  (`source_of_change:'notion'`, `sync_status:'synced'`).
- Local **newer or equal** → leave the row untouched; the push phase sends it to
  Notion instead.

A newer local change is never overwritten by a stale Notion value, and vice versa.

### Push (local → Notion)

Local rows changed since their last sync that originated locally
(`source_of_change != 'notion'` **and** `updated_at > last_synced_at`, a null
`last_synced_at` meaning "never synced") are rebuilt with the schema + mapping and
written via `updatePage`. On success: `sync_status:'synced'`, `last_synced_at:now`
(local `source_of_change` retained). On failure: `sync_status:'error'`, recorded in
`errors`, and the pass continues.

### Watermark semantics

`user_sync_state.last_synced_at` is the user's last **successful** pull instant
(else the epoch). It is written to the query filter as `last_edited_time after`,
so a later run only sees newer pages. The watermark advances to the run instant
**only when the pull pass completed with no errors** — a failed database/page is
retried on the next run rather than being skipped forever.

### Loop prevention

- After a **pull write** the row is stamped `source_of_change:'notion'`, so the
  push candidate filter skips it — a pulled row is never immediately pushed back.
- After a **push**, `last_synced_at:now` is set: the next pull's per-row guard
  ignores any page whose `last_edited_time` is **≤** that row's `last_synced_at`,
  and the query watermark (`after now`) excludes it at the source — a pushed row is
  not re-pulled.

### Failure isolation

Every database and every page/task is wrapped individually; `syncUser` never
throws and always returns a summary. Per-database and per-item failures are
recorded in `errors` and do not abort the run.

### Scheduler

`startSyncScheduler`/`stopSyncScheduler`
([`services/sync/scheduler.ts`](../server/src/services/sync/scheduler.ts:1)) wrap
`syncUser` in a `setInterval` loop with an overlap guard and `unref()`, armed only
by `src/index.ts` and stopped on `SIGTERM`/`SIGINT`. It is **disabled by default**
(`SYNC_ENABLED=false`) and additionally requires Supabase + Notion to be
configured. Enable periodic sync with:

```
SYNC_ENABLED=true
SYNC_TICK_MS=900000   # optional, default 15 minutes
```

Each tick enumerates the users with a stored Notion connection (bounded) and
reconciles each independently, honouring the shared per-user cooldown. The loop is
inert in tests (no timer is created).
