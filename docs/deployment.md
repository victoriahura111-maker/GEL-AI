# Deployment

Everything needed to ship the AI Virtual Task Assistant: the complete environment
reference, Supabase/Notion/AI setup, build & start commands, containerization,
hosting guidance, health probes, the single-instance scheduler caveat,
observability, backups, rollback, and a final production checklist.

The server reads configuration from a single **repository-root** `.env` file
(git-ignored). Copy the template and fill it in:

```bash
cp .env.example .env
```

The config is validated at boot ([`server/src/config/index.ts`](../server/src/config/index.ts)):

- **production** — a missing _required_ variable prints the offending names and
  exits non-zero;
- **development/test** — a warning is printed and safe local defaults apply.

Never commit `.env`; only the blank [`.env.example`](../.env.example) is
committed.

---

## 1. Environment variables

### Core

| Variable   | Required | Default       | Notes                                                                                          |
| ---------- | -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `NODE_ENV` | no       | `development` | `development` \| `test` \| `production`. In `test`, rate limiters are skipped.                 |
| `PORT`     | no       | `4000`        | HTTP listen port.                                                                              |
| `API_URL`  | **yes**  | —             | Public base URL of the API (e.g. `https://api.example.com`).                                   |
| `APP_URL`  | **yes**  | —             | Public base URL of the SPA (e.g. `https://app.example.com`). Used for the post-OAuth redirect. |

### Supabase

| Variable                    | Required | Notes                                                       |
| --------------------------- | -------- | ----------------------------------------------------------- |
| `SUPABASE_URL`              | **yes**  | Project URL.                                                |
| `SUPABASE_ANON_KEY`         | **yes**  | Public anon key (RLS-scoped).                               |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes**  | **Server-only**; bypasses RLS. Never expose to the browser. |

### AI provider (OpenAI-compatible)

| Variable      | Required | Default                     | Notes                                               |
| ------------- | -------- | --------------------------- | --------------------------------------------------- |
| `AI_PROVIDER` | **yes**  | —                           | Informational label (documentation/telemetry only). |
| `AI_API_KEY`  | **yes**  | —                           | Never logged or returned.                           |
| `AI_MODEL`    | **yes**  | —                           | Chat-completions model id.                          |
| `AI_BASE_URL` | no       | `https://api.openai.com/v1` | Point at any OpenAI-compatible gateway.             |

### Notion OAuth + encryption

| Variable               | Required | Notes                                                                                                                                                               |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTION_CLIENT_ID`     | **yes**  | Public by design.                                                                                                                                                   |
| `NOTION_CLIENT_SECRET` | **yes**  | Never logged or sent to the browser.                                                                                                                                |
| `NOTION_REDIRECT_URI`  | **yes**  | Must match the Notion app registration exactly (e.g. `https://api.example.com/api/notion/oauth/callback`).                                                          |
| `ENCRYPTION_KEY`       | **yes**  | `>= 32` characters. Encrypts stored Notion tokens and signs OAuth state. **Back it up; rotating it invalidates existing stored tokens and in-flight OAuth states.** |

### Reminders (Phase 13)

| Variable            | Default | Notes                             |
| ------------------- | ------- | --------------------------------- |
| `REMINDER_TICK_MS`  | `60000` | Worker interval in ms.            |
| `REMINDERS_ENABLED` | `true`  | Scheduler also requires Supabase. |

### Follow-ups (Phase 15)

| Variable                       | Default  | Notes                                   |
| ------------------------------ | -------- | --------------------------------------- |
| `FOLLOW_UP_ENABLED`            | `true`   | Scheduler also requires Supabase.       |
| `FOLLOW_UP_TICK_MS`            | `300000` | Worker interval in ms.                  |
| `FOLLOW_UP_LEAD_HOURS`         | `24`     | How far ahead of the deadline to chase. |
| `FOLLOW_UP_MIN_INTERVAL_HOURS` | `20`     | Minimum gap between chase-ups.          |
| `FOLLOW_UP_MAX_PER_TASK`       | `3`      | Cap per task.                           |

### Notion sync (Phase 16)

| Variable               | Default  | Notes                                                                    |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `SYNC_ENABLED`         | `false`  | Periodic worker is **opt-in**. Manual `POST /api/sync` works regardless. |
| `SYNC_TICK_MS`         | `900000` | Worker interval (15 min).                                                |
| `SYNC_MIN_INTERVAL_MS` | `10000`  | Per-user manual-sync cooldown.                                           |

### Security hardening (Phase 17)

| Variable                   | Default                 | Notes                                                                                                                                                                                                              |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CORS_ORIGIN`              | falls back to `APP_URL` | Allowed SPA origin(s). Single value or comma-separated list. Other browser origins receive `403`.                                                                                                                  |
| `TRUST_PROXY`              | `false`                 | Express `trust proxy`. Set to the number of trusted hops (or `1`/`true`) **only** when behind a trusted reverse proxy; enabling it on a directly exposed server lets clients spoof their IP via `X-Forwarded-For`. |
| `RATE_LIMIT_WINDOW_MS`     | `60000`                 | Rate-limit window.                                                                                                                                                                                                 |
| `RATE_LIMIT_MAX`           | `300`                   | Global `/api/*` requests per window.                                                                                                                                                                               |
| `RATE_LIMIT_ASSISTANT_MAX` | `30`                    | Assistant endpoints per window.                                                                                                                                                                                    |
| `RATE_LIMIT_SYNC_MAX`      | `10`                    | `POST /api/sync` per window.                                                                                                                                                                                       |
| `RATE_LIMIT_NOTION_MAX`    | `60`                    | `/api/notion/*` per window.                                                                                                                                                                                        |

### Frontend (Vite)

| Variable                 | Required | Notes                                 |
| ------------------------ | -------- | ------------------------------------- |
| `VITE_SUPABASE_URL`      | **yes**  | Browser Supabase URL.                 |
| `VITE_SUPABASE_ANON_KEY` | **yes**  | Browser anon key (RLS protects data). |

> Only `VITE_*` values are inlined into the client bundle. Never put a server
> secret (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `NOTION_CLIENT_SECRET`,
> `AI_API_KEY`) behind a `VITE_` name.

---

## 2. Supabase setup

1. **Create the project** in the Supabase dashboard and note the project URL, anon
   key, and service-role key (Project Settings → API).
2. **Apply the migrations** in numeric order — `0001` … `0011` in
   [`database/migrations/`](../database/migrations):
   - _SQL editor:_ open each file and run it, in order.
   - _Supabase CLI:_ `supabase db push` (or `supabase migration up`) against the
     linked project.
     The migrations are idempotent-ish (`create table if not exists`,
     `add column if not exists`, `drop policy if exists`) so a re-run is safe.
3. **Verify RLS.** Every table enables Row Level Security in its migration. Confirm
   quickly in the SQL editor:
   ```sql
   select relname, relrowsecurity
   from pg_class
   where relnamespace = 'public'::regnamespace and relkind = 'r'
   order by relname;
   ```
   Every application table (`user_profiles`, `assistant_*`, `notion_*`,
   `user_sync_state`) must show `relrowsecurity = true`. A sanity check with the
   **anon** key from a scratch app should return zero rows for another user.
4. **Auth redirect URLs.** In Authentication → URL Configuration set the **Site
   URL** to `APP_URL`, and add your SPA origin (and any auth callback paths, e.g.
   `${APP_URL}/reset-password`) to the allowed **Redirect URLs**. Email/password
   auth is used; configure email templates/providers as desired.
5. The server uses the **service-role** key via a server-only admin client; it
   bypasses RLS, which is why every repository query is _also_ filtered by
   `user_id` (defense-in-depth). Never import the admin client into the SPA.

---

## 3. Notion integration setup

1. **Create a public integration** at <https://www.notion.so/my-integrations> and
   copy its **client id** and **client secret** into `NOTION_CLIENT_ID` /
   `NOTION_CLIENT_SECRET`.
2. **Register the redirect URI** in the integration settings. It must match
   `NOTION_REDIRECT_URI` character-for-character:
   ```
   http://localhost:4000/api/notion/oauth/callback        # local development
   https://<your-api-domain>/api/notion/oauth/callback    # production
   ```
3. **Share databases with the integration.** Notion only returns databases the
   user has explicitly shared: in Notion, open a database → `•••` → **Connections**
   → add your integration. Repeat per database. Unshared databases never appear in
   discovery.
4. Users then connect from **Settings → Notion** in the SPA
   (`GET /api/notion/oauth/start` → Notion consent → callback). The access token
   is AES-256-GCM encrypted before storage; it never reaches the browser.

---

## 4. AI provider configuration

Set `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, and (optionally) `AI_BASE_URL`. The
provider must speak the OpenAI **chat-completions** API and support JSON mode
(`response_format: { type: 'json_object' }`) — OpenAI, Azure OpenAI, OpenRouter,
Groq, and most local servers qualify. The server requests structured JSON and
validates it with Zod, retrying once with a corrective message on a malformed
response; a final failure returns a user-safe `502`. `AI_API_KEY` is never logged.

---

## 5. Build & start

```bash
npm ci                       # install all workspaces (reproducible)
npm run build                # server (tsc) + client (vite build)
NODE_ENV=production npm start   # run the compiled API
```

- Server build output: `server/dist/` (entrypoint `server/dist/index.js`).
- Client build output: `client/dist/` (static assets).
- `npm start` (alias `npm run start:server`) runs `node server/dist/index.js`.
- `NODE_ENV=production` must be set so the config validates strictly and exits on
  missing required variables.

---

## 6. Container image

A multi-stage [`server/Dockerfile`](../server/Dockerfile) (install → build →
slim, non-root runtime, `NODE_ENV=production`, `HEALTHCHECK` on `/health`) builds
the API. Because this is an npm-workspaces monorepo, build **from the repository
root**:

```bash
docker build -f server/Dockerfile -t ai-virtual-task-assistant-api .
docker run --env-file .env -p 4000:4000 ai-virtual-task-assistant-api
```

A minimal [`docker-compose.yml`](../docker-compose.yml) is provided for
convenience; it contains **no secrets** and reads every value from your `.env`
(via `env_file`). The SPA is not containerized — build it separately
(`npm run build -w client`) and serve `client/dist` as static files.

---

## 7. Hosting guidance

- **API** — a Node host (Render/Fly/Railway/ECS/VM) or the container above. Put it
  behind TLS (terminating at the proxy) and set `TRUST_PROXY` if the proxy is
  trusted. Keep it a **single instance** while the schedulers are enabled (see §9).
- **SPA** — serve `client/dist` from a static host/CDN. Because the SPA calls the
  API on the **same origin** by default (`/api/...`, no `VITE_API_URL`), either:
  - proxy `/api` and `/health` to the API from the static host / edge (recommended),
    or
  - serve the SPA from the same origin as the API.
    Set `CORS_ORIGIN` to the SPA origin regardless (a mismatch returns `403`).
- **TLS & headers.** Terminate TLS at the proxy. Helmet already sets safe JSON-API
  headers; the SPA host should set standard static-asset headers.

---

## 8. Health & readiness probes

| Endpoint            | Purpose   | Response                                                                                                         |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /health`       | Liveness  | Always `200 { "status": "ok" }`. Performs no I/O; safe to poll frequently.                                       |
| `GET /health/ready` | Readiness | `200` when **Supabase is configured**, else `503`. Body: `{ status, checks, schedulersEnabled, uptimeSeconds }`. |

`GET /health/ready` exposes **booleans and metadata only** — never a URL, key,
token, or secret:

```jsonc
{
  "status": "ready", // "degraded" when Supabase is unconfigured
  "checks": { "supabase": true, "ai": false, "notion": true, "encryption": true },
  "schedulersEnabled": { "reminders": true, "followUps": true, "sync": false },
  "uptimeSeconds": 42,
}
```

Readiness is configuration-based (it does not ping the dependencies), so it is
cheap and safe to call on every probe. Use `/health` for liveness and
`/health/ready` for readiness; the Docker image's `HEALTHCHECK` uses `/health`.

---

## 9. Scheduler / single-instance caveat

Three background workers are started by [`server/src/index.ts`](../server/src/index.ts):
the **reminder** and **follow-up** schedulers (Supabase required) and the opt-in
**sync** scheduler (`SYNC_ENABLED=true`, Supabase + Notion required). All are
stopped on `SIGTERM`/`SIGINT`, and the HTTP server then drains in-flight requests
with a 10-second forced-exit timeout.

- **Claiming is idempotent.** Reminders are atomically claimed
  (`UPDATE … SET status='sent' WHERE id=? AND status='pending'`), so a delivered
  reminder is never sent twice even if two ticks overlap. The same pattern guards
  follow-ups.
- **But the tickers are process-local.** Running **multiple API replicas** can:
  duplicate tick work, and split the in-process OAuth single-use `state` store
  (replay protection is then best-effort across instances). **Recommendation:
  run the workers in exactly one instance**, or put the periodic work behind a
  distributed lock / dedicated worker and disable the flags on the web replicas
  (`REMINDERS_ENABLED=false FOLLOW_UP_ENABLED=false SYNC_ENABLED=false`). For
  strict OAuth single-use across replicas, back the consumed-nonce store with a
  shared store (e.g. Redis or Postgres).

---

## 10. Observability

- **Request logs.** One redacted line per completed request (method, path with
  sensitive query params masked, status, duration, user id). `Authorization`/
  `Cookie` headers and bodies are never logged. Ship stdout to your log platform.
- **Audit trail.** `assistant_audit_logs` records task create/update/delete,
  reminder delivery/failure, follow-up sends/responses, Notion connect/disconnect,
  database mapping changes, and sync runs (counts only). Writes are best-effort
  and never fail a user action.
- **Sync status.** `GET /api/sync/status` returns the watermark
  (`lastSyncedAt`), last direction, last error, per-status counts, and recent safe
  errors.
- **Reminder/notification state.** `GET /api/reminders` and
  `GET /api/notifications` expose delivery state for the caller.
- **Boot warnings.** A misconfigured boot logs which variables are missing (dev)
  or exits (production). Scheduler skips are logged with the reason
  (unconfigured/disabled).

---

## 11. Backups

- **Database.** Enable Supabase's automated backups (or Point-in-Time Recovery on
  paid plans) for the project's Postgres. Periodically verify a restore into a
  scratch project.
- **`ENCRYPTION_KEY`.** Back up `ENCRYPTION_KEY` in your secret manager. The
  service-role key and Notion AI credentials can be rotated, but losing
  `ENCRYPTION_KEY` makes existing encrypted Notion tokens unrecoverable (users
  must reconnect Notion).
- **Notion.** Notion is the source of truth for task content, but keep the
  Supabase backup for reminders, audit history, and mirror state.

---

## 12. Rollback

- **Application.** Redeploy the previous build artifact/image (e.g. re-tag the
  prior image or redeploy the previous commit). The server is stateless — all
  state lives in Supabase/Notion — so a rollback is just a redeploy.
- **Configuration.** Env changes take effect on restart. Rotating
  `ENCRYPTION_KEY` is **not** a safe rollback: it invalidates stored tokens.
- **Migrations.** The Phase 7–16 migrations are additive. To roll one back, take a
  backup first, then apply the inverse (e.g. drop the added columns/table) —
  there are no destructive down-migrations shipped. Prefer forward fixes.
- **Feature kill-switches.** `REMINDERS_ENABLED`, `FOLLOW_UP_ENABLED`, and
  `SYNC_ENABLED=false` disable the background workers without a code change, and
  `RATE_LIMIT_*` / `CORS_ORIGIN` can be adjusted live via restart if the edge is
  misbehaving.

---

## 13. Production checklist

- [ ] `NODE_ENV=production` set (a missing required variable exits at boot).
- [ ] Every **required** variable from §1 is set in a secret manager — never in
      the repo or the client bundle.
- [ ] `ENCRYPTION_KEY` is ≥ 32 characters, stored in a secret manager, and backed up.
- [ ] Supabase project created; migrations `0001`–`0011` applied in order.
- [ ] RLS verified enabled on every application table (§2).
- [ ] Supabase Auth **Site URL** = `APP_URL` and redirect URLs configured.
- [ ] Notion integration created; `NOTION_REDIRECT_URI` registered exactly; the
      target databases shared with the integration.
- [ ] AI provider set and reachable; `AI_MODEL` valid for that provider.
- [ ] `CORS_ORIGIN` set to the deployed SPA origin(s) — **not** a wildcard.
- [ ] `TRUST_PROXY` matches the deployment topology (off if directly exposed).
- [ ] `npm run build` succeeds for both workspaces and `npm run lint` passes.
- [ ] `npm test` and `npm run test:coverage` are green.
- [ ] The image/process passes `GET /health` (and `GET /health/ready` is `200`
      with Supabase configured).
- [ ] Background workers run on exactly **one** instance (§9).
- [ ] Log shipping and Supabase backups enabled; rollback plan understood (§12).
- [ ] The service-role key and `NOTION_CLIENT_SECRET` are never exposed to the
      client bundle or logs.

See [`docs/security.md`](./security.md) for the full security model and
[`docs/testing.md`](./testing.md) for the test/coverage strategy.
